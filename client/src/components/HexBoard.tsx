import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FEET_PER_HEX,
  HEX_RADIUS,
  boardBounds,
  boardHexes,
  hexCorners,
  hexDistance,
  hexToPoint,
  hexesInRange,
  onBoard,
  pointToHex,
  type Hex,
  type Point,
} from '../../../shared/hex.ts';
import { SEATS, type RoomState, type Token } from '../../../shared/protocol.ts';
import { SIDE_ROTATION } from '../seats.ts';

export interface Camera {
  x: number; // centre of the view, in map units
  y: number;
  scale: number; // screen pixels per map unit (= per hex width)
}

interface Props {
  state: RoomState;
  camera: Camera;
  /** Phones and the DM can pan and zoom their own view; the Main Screen can't. */
  onCameraChange?: (camera: Camera) => void;
  canDrag: (token: Token) => boolean;
  onMoveToken: (token: Token, hex: Hex) => Promise<unknown>;
  selectedTokenId?: string | null;
  onSelectToken?: (token: Token | null) => void;
  /** Turn token labels to face the player sitting at the token owner's seat (Main Screen). */
  faceSeats?: boolean;
  /** DM only: show (and let them drag) the area the Main Screen is showing. */
  tableFrame?: { onMove: (center: Point) => void };
}

const MIN_SCALE = 12;
const MAX_SCALE = 220;

/** Draws the hex map with its tokens. Used on the Main Screen, phones and the DM device. */
export function HexBoard({
  state,
  camera,
  onCameraChange,
  canDrag,
  onMoveToken,
  selectedTokenId,
  onSelectToken,
  faceSeats,
  tableFrame,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // A token being dragged: where the finger/mouse currently is (map units).
  const [drag, setDrag] = useState<{ id: string; at: Point } | null>(null);
  // Moves sent to the server but not yet confirmed, shown right away.
  const [pending, setPending] = useState<Record<string, Hex>>({});
  const [frameDrag, setFrameDrag] = useState<{ start: Point; offset: Point } | null>(null);
  const pointers = useRef(new Map<number, Point>()); // screen positions, for panning/pinching
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Once the server confirms a move (or the token is moved elsewhere), drop the pending copy.
  useEffect(() => {
    setPending((p) => {
      const next = { ...p };
      for (const t of state.tokens) if (next[t.id] && next[t.id].q === t.q && next[t.id].r === t.r) delete next[t.id];
      return next;
    });
  }, [state.tokens]);

  const toMap = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - size.w / 2) / camera.scale + camera.x,
      y: (clientY - rect.top - size.h / 2) / camera.scale + camera.y,
    };
  };

  // ---- static layers (only recalculated when the board changes) ----
  const gridPath = useMemo(() => {
    return boardHexes(state.board)
      .map((h) => {
        const c = hexCorners(hexToPoint(h));
        return `M${c.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join('L')}Z`;
      })
      .join('');
  }, [state.board]);
  const bounds = boardBounds(state.board);

  const highlightToken = state.highlight && state.tokens.find((t) => t.id === state.highlight!.tokenId);
  const highlightPath = useMemo(() => {
    if (!state.highlight || !highlightToken) return '';
    const range = Math.floor(state.highlight.feet / FEET_PER_HEX);
    return hexesInRange(highlightToken, range)
      .filter((h) => onBoard(h, state.board) && hexDistance(h, highlightToken) > 0)
      .map((h) => {
        const c = hexCorners(hexToPoint(h), HEX_RADIUS * 0.97);
        return `M${c.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join('L')}Z`;
      })
      .join('');
  }, [state.highlight, highlightToken?.q, highlightToken?.r, state.board]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- panning & zooming (phones and DM) ----
  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (!onCameraChange) {
      onSelectToken?.(null);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: camera.scale };
    }
  }
  function onBackgroundPointerMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !onCameraChange) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const scale = clamp((pinch.current.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.dist, MIN_SCALE, MAX_SCALE);
      onCameraChange({ ...camera, scale });
    } else if (pointers.current.size === 1) {
      onCameraChange({ ...camera, x: camera.x - (now.x - prev.x) / camera.scale, y: camera.y - (now.y - prev.y) / camera.scale });
    }
  }
  function onBackgroundPointerUp(e: React.PointerEvent) {
    const start = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (start && Math.hypot(start.x - e.clientX, start.y - e.clientY) < 4) onSelectToken?.(null);
  }
  function onWheel(e: React.WheelEvent) {
    if (!onCameraChange) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE);
    // zoom towards the mouse position
    const at = toMap(e.clientX, e.clientY);
    onCameraChange({
      scale,
      x: at.x - (at.x - camera.x) * (camera.scale / scale),
      y: at.y - (at.y - camera.y) * (camera.scale / scale),
    });
  }

  // ---- dragging tokens ----
  function onTokenPointerDown(e: React.PointerEvent, token: Token) {
    e.stopPropagation();
    onSelectToken?.(token);
    if (!canDrag(token)) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: token.id, at: toMap(e.clientX, e.clientY) });
  }
  function onTokenPointerMove(e: React.PointerEvent, token: Token) {
    if (drag?.id !== token.id) return;
    setDrag({ id: token.id, at: toMap(e.clientX, e.clientY) });
  }
  function onTokenPointerUp(e: React.PointerEvent, token: Token) {
    if (drag?.id !== token.id) return;
    setDrag(null);
    const hex = pointToHex(toMap(e.clientX, e.clientY));
    if ((hex.q === token.q && hex.r === token.r) || !onBoard(hex, state.board)) return;
    if (state.tokens.some((t) => t.id !== token.id && t.q === hex.q && t.r === hex.r)) return;
    setPending((p) => ({ ...p, [token.id]: hex }));
    onMoveToken(token, hex).catch(() =>
      setPending((p) => {
        const next = { ...p };
        delete next[token.id];
        return next;
      }),
    );
  }

  // ---- the Main Screen frame on the DM's map ----
  const tableArea = (() => {
    const t = state.table;
    if (!tableFrame || !t.viewport) return null;
    const unitPx = t.pxPerMm * t.hexMm;
    const center = frameDrag ? { x: frameDrag.start.x + frameDrag.offset.x, y: frameDrag.start.y + frameDrag.offset.y } : state.view;
    return { w: t.viewport.w / unitPx, h: t.viewport.h / unitPx, center };
  })();
  const frameGrab = useRef<Point | null>(null);

  const seatSide = (ownerId: string | null) => {
    const seat = state.members.find((m) => m.id === ownerId)?.seat;
    return SEATS.find((s) => s.id === seat)?.side ?? 'bottom';
  };

  const transform = `translate(${size.w / 2} ${size.h / 2}) scale(${camera.scale}) translate(${-camera.x} ${-camera.y})`;
  const px = 1 / camera.scale; // one screen pixel in map units, for line widths

  return (
    <svg
      ref={svgRef}
      className="hex-board"
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onPointerCancel={onBackgroundPointerUp}
      onWheel={onWheel}
    >
      <g transform={transform}>
        <rect
          className="board-bg"
          x={bounds.minX}
          y={bounds.minY}
          width={bounds.maxX - bounds.minX}
          height={bounds.maxY - bounds.minY}
        />
        <path className="grid" d={gridPath} strokeWidth={Math.max(px, 0.012)} />
        {highlightPath && (
          <path className={`highlight ${state.highlight!.kind}`} d={highlightPath} strokeWidth={2 * px} />
        )}

        {state.tokens.map((token) => {
          const dragging = drag?.id === token.id;
          const hex = pending[token.id] ?? token;
          const at = dragging ? drag.at : hexToPoint(hex);
          const rotation = faceSeats && token.kind === 'player' ? SIDE_ROTATION[seatSide(token.ownerId)] : 0;
          const selected = selectedTokenId === token.id;
          return (
            <g
              key={token.id}
              className={`token ${token.kind} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${canDrag(token) ? 'draggable' : ''}`}
              transform={`translate(${at.x} ${at.y})`}
              onPointerDown={(e) => onTokenPointerDown(e, token)}
              onPointerMove={(e) => onTokenPointerMove(e, token)}
              onPointerUp={(e) => onTokenPointerUp(e, token)}
              onPointerCancel={() => setDrag(null)}
              data-testid={`token-${token.name}`}
            >
              {/* outer ring stays visible around a miniature's base */}
              <circle r={0.47} className="token-ring" stroke={token.color} />
              <circle r={0.36} fill={token.color} className="token-body" />
              <text transform={`rotate(${rotation})`} className="token-label" dy="0.35em">
                {token.label}
              </text>
              {token.kind === 'monster' && <circle r={0.36} className="token-monster-mark" />}
            </g>
          );
        })}

        {tableArea && (
          <g
            className="table-frame"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
              frameGrab.current = toMap(e.clientX, e.clientY);
              setFrameDrag({ start: state.view, offset: { x: 0, y: 0 } });
            }}
            onPointerMove={(e) => {
              if (!frameGrab.current) return;
              const now = toMap(e.clientX, e.clientY);
              setFrameDrag({ start: state.view, offset: { x: now.x - frameGrab.current.x, y: now.y - frameGrab.current.y } });
            }}
            onPointerUp={() => {
              if (frameGrab.current && tableArea) tableFrame!.onMove(tableArea.center);
              frameGrab.current = null;
              setFrameDrag(null);
            }}
          >
            <rect
              className="frame"
              x={tableArea.center.x - tableArea.w / 2}
              y={tableArea.center.y - tableArea.h / 2}
              width={tableArea.w}
              height={tableArea.h}
              strokeWidth={4 * px}
            />
            {/* the handle: grab it to move what the Main Screen shows */}
            <rect
              className="handle"
              x={tableArea.center.x - tableArea.w / 2}
              y={tableArea.center.y - tableArea.h / 2}
              width={190 * px}
              height={30 * px}
              rx={4 * px}
            />
            <text
              className="handle-text"
              x={tableArea.center.x - tableArea.w / 2 + 10 * px}
              y={tableArea.center.y - tableArea.h / 2 + 20 * px}
              fontSize={13 * px}
            >
              ✥ Main Screen – drag to move
            </text>
          </g>
        )}
      </g>
    </svg>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
