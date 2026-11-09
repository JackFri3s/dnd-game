import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SEATS, type Area, type Highlight, type RoomState, type Token } from '../../../shared/protocol.ts';
import {
  MIN_TOKEN_GAP,
  TOKEN_RADIUS,
  areaGeometry,
  clampToBoard,
  dist,
  geometryPath,
  onBoard,
  toFeet,
  toUnits,
  type Point,
} from '../../../shared/geometry.ts';
import { SIDE_ROTATION } from '../seats.ts';
import { formatDistance, useSettings } from '../settings.ts';
import type { Entrance } from '../../../shared/places.ts';
import { EntranceMarkers, PlaceLayer } from './PlaceLayer.tsx';

export interface Camera {
  x: number; // centre of the view, in map units (1 unit = 5 ft)
  y: number;
  scale: number; // screen pixels per map unit
}

/** A map tool that takes presses on the map (the DM's map editor). */
export interface MapTool {
  /** A press on the map: return true to take it (the map then doesn't pan). */
  down(at: Point): boolean;
  move(at: Point): void;
  up(at: Point): void;
  /** Drawn over the map (handles, the shape being drawn). `px` is one screen pixel in map units. */
  overlay?: (px: number) => ReactNode;
}

/** An area being aimed (not placed yet), drawn dashed. */
export type AreaPreview = Omit<Area, 'id' | 'placedBy' | 'at'>;

interface Props {
  state: RoomState;
  camera: Camera;
  /** Phones and the DM can pan and zoom their own view; the Main Screen can't. */
  onCameraChange?: (camera: Camera) => void;
  canDrag: (token: Token) => boolean;
  onMoveToken: (token: Token, to: Point) => Promise<unknown>;
  selectedTokenId?: string | null;
  onSelectToken?: (token: Token | null) => void;
  /** Turn token labels to face the player sitting at the token owner's seat (Main Screen). */
  faceSeats?: boolean;
  /** DM only: show (and let them drag) the area the Main Screen is showing. */
  tableFrame?: { onMove: (center: Point) => void };
  /** Tapping the map (e.g. to aim a spell). */
  onTapMap?: (at: Point) => void;
  /** A spell area being aimed. */
  areaPreview?: AreaPreview | null;
  /** How far a token has moved this turn (combat), to count its remaining movement. */
  movedFt?: (token: Token) => number;
  /** Whose turn it is in combat. */
  currentTokenId?: string | null;
  /** DM: show monsters' hit points under their tokens. */
  showHp?: boolean;
  /** A range shown only on this screen (dashed), before it is shown on the table. */
  localHighlight?: Highlight | null;
  /** Tapping a door, cave mouth or stairs. */
  onTapEntrance?: (entrance: Entrance) => void;
  selectedEntranceId?: string | null;
  /** The DM's map editor: takes presses, tokens can't be dragged meanwhile. */
  tool?: MapTool | null;
}

const MIN_SCALE = 8;

// Paper textures (drawn by the browser from SVG noise) for the parchment style.
const GRAIN = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.36 0 0 0 0 0.26 0 0 0 0 0.13 0 0 0 0.2 0'/></filter><rect width='256' height='256' filter='url(#g)'/></svg>",
)}`;
const STAINS = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='768' height='768'><filter id='s'><feTurbulence type='fractalNoise' baseFrequency='0.005' numOctaves='4' seed='5' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.36 0 0 0 0 0.16 0 0 0 0.6 -0.25'/></filter><rect width='768' height='768' filter='url(#s)'/></svg>",
)}`;
const MAX_SCALE = 220;

/** Draws the (gridless) map with its tokens. Used on the Main Screen, phones and the DM device. */
export function MapBoard({
  state,
  camera,
  onCameraChange,
  canDrag,
  onMoveToken,
  selectedTokenId,
  onSelectToken,
  faceSeats,
  tableFrame,
  onTapMap,
  areaPreview,
  movedFt,
  currentTokenId,
  showHp,
  localHighlight,
  onTapEntrance,
  selectedEntranceId,
  tool,
}: Props) {
  const toolPointer = useRef<number | null>(null);
  const { unit } = useSettings();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // A token being dragged: where it started and where the finger/mouse is now (map units).
  const [drag, setDrag] = useState<{ id: string; from: Point; at: Point } | null>(null);
  // Moves sent to the server but not yet confirmed, shown right away.
  const [pending, setPending] = useState<Record<string, Point>>({});
  const [frameDrag, setFrameDrag] = useState<{ start: Point; offset: Point } | null>(null);
  const frameGrab = useRef<Point | null>(null);
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
      for (const t of state.tokens) if (next[t.id] && dist(next[t.id], t) < 0.01) delete next[t.id];
      return next;
    });
  }, [state.tokens]);

  // Another place: nothing from the old map is pending any more.
  useEffect(() => setPending({}), [state.placeId]);

  const toMap = (clientX: number, clientY: number): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - size.w / 2) / camera.scale + camera.x,
      y: (clientY - rect.top - size.h / 2) / camera.scale + camera.y,
    };
  };
  const posOf = (t: Token): Point => pending[t.id] ?? t;

  // ---- movement / range highlights: circles around the token ----
  const circlesFor = (h: Highlight | null | undefined) => {
    const t = h && state.tokens.find((x) => x.id === h.tokenId);
    if (!h || !t) return null;
    const at = posOf(t);
    if (h.kind === 'move') return { kind: h.kind, at, near: toUnits(Math.max(0, h.feet - (movedFt?.(t) ?? 0))), far: 0 };
    // Ranges count from the edge of the creature's space.
    return { kind: h.kind, at, near: TOKEN_RADIUS + toUnits(h.feet), far: h.longFeet ? TOKEN_RADIUS + toUnits(h.longFeet) : 0 };
  };
  const highlight = circlesFor(state.highlight);
  const sameAsShared =
    !!localHighlight && !!state.highlight && localHighlight.tokenId === state.highlight.tokenId && localHighlight.kind === state.highlight.kind && localHighlight.feet === state.highlight.feet;
  const local = sameAsShared ? null : circlesFor(localHighlight);

  // ---- spell areas, and the one being aimed ----
  const areaShapes = useMemo(
    () => state.areas.map((a) => ({ area: a, d: geometryPath(areaGeometry({ shape: a.shape, sizeFt: a.sizeFt, widthFt: a.widthFt }, a.origin, a.target, a.rangeFt)) })),
    [state.areas],
  );
  const previewPath = areaPreview
    ? geometryPath(areaGeometry({ shape: areaPreview.shape, sizeFt: areaPreview.sizeFt, widthFt: areaPreview.widthFt }, areaPreview.origin, areaPreview.target, areaPreview.rangeFt))
    : '';

  // ---- the line and distance while dragging a token ----
  const dragToken = drag ? state.tokens.find((t) => t.id === drag.id) : null;
  const dragInfo = (() => {
    if (!drag || !dragToken) return null;
    const ft = toFeet(dist(drag.from, drag.at));
    const limit = dragToken.speedFt - (movedFt?.(dragToken) ?? 0);
    const blocked = state.tokens.some((t) => t.id !== dragToken.id && dist(posOf(t), drag.at) < MIN_TOKEN_GAP);
    return { ft, over: ft > limit + 0.5, blocked };
  })();

  // ---- panning & zooming (phones and DM) ----
  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (tool && pointers.current.size === 0 && tool.down(toMap(e.clientX, e.clientY))) {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      toolPointer.current = e.pointerId;
      return;
    }
    if (!onCameraChange) {
      if (onTapMap) onTapMap(toMap(e.clientX, e.clientY));
      else onSelectToken?.(null);
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
    if (toolPointer.current === e.pointerId) {
      tool?.move(toMap(e.clientX, e.clientY));
      return;
    }
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
    if (toolPointer.current === e.pointerId) {
      toolPointer.current = null;
      tool?.up(toMap(e.clientX, e.clientY));
      return;
    }
    const start = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (start && Math.hypot(start.x - e.clientX, start.y - e.clientY) < 6) {
      if (onTapMap) onTapMap(toMap(e.clientX, e.clientY));
      else onSelectToken?.(null);
    }
  }
  function onWheel(e: React.WheelEvent) {
    if (!onCameraChange) return;
    const scale = clamp(camera.scale * Math.exp(-e.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
    const at = toMap(e.clientX, e.clientY);
    onCameraChange({ scale, x: at.x - (at.x - camera.x) * (camera.scale / scale), y: at.y - (at.y - camera.y) * (camera.scale / scale) });
  }

  // ---- dragging tokens ----
  function onTokenPointerDown(e: React.PointerEvent, token: Token) {
    e.stopPropagation();
    if (onTapMap) {
      onTapMap(posOf(token)); // aiming at a creature
      return;
    }
    onSelectToken?.(token);
    if (!canDrag(token)) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: token.id, from: posOf(token), at: toMap(e.clientX, e.clientY) });
  }
  function onTokenPointerMove(e: React.PointerEvent, token: Token) {
    if (drag?.id !== token.id) return;
    setDrag({ ...drag, at: toMap(e.clientX, e.clientY) });
  }
  function onTokenPointerUp(e: React.PointerEvent, token: Token) {
    if (drag?.id !== token.id) return;
    const to = clampToBoard(toMap(e.clientX, e.clientY), state.board);
    const blocked = dragInfo?.blocked;
    setDrag(null);
    if (dist(to, posOf(token)) < 0.1 || !onBoard(to, state.board) || blocked) return;
    setPending((p) => ({ ...p, [token.id]: to }));
    onMoveToken(token, to).catch(() =>
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

  const seatSide = (ownerId: string | null) => {
    const seat = state.members.find((m) => m.id === ownerId)?.seat;
    return SEATS.find((s) => s.id === seat)?.side ?? 'bottom';
  };

  const transform = `translate(${size.w / 2} ${size.h / 2}) scale(${camera.scale}) translate(${-camera.x} ${-camera.y})`;
  const px = 1 / camera.scale; // one screen pixel in map units, for line widths

  return (
    <svg
      ref={svgRef}
      className={`map-board ${onTapMap ? 'aiming' : ''} ${tool ? 'editing' : ''}`}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onPointerCancel={onBackgroundPointerUp}
      onWheel={onWheel}
    >
      <g transform={transform}>
        <defs>
          {/* Parchment style: paper grain and stains that move and zoom with the map */}
          <pattern id="board-grain" patternUnits="userSpaceOnUse" width={4} height={4}>
            <image href={GRAIN} width={4} height={4} />
          </pattern>
          <pattern id="board-stains" patternUnits="userSpaceOnUse" width={24} height={24}>
            <image href={STAINS} width={24} height={24} />
          </pattern>
          <radialGradient id="board-vignette" cx="50%" cy="50%" r="70%">
            <stop offset="70%" stopColor="rgb(110,75,30)" stopOpacity={0} />
            <stop offset="100%" stopColor="rgb(110,75,30)" stopOpacity={0.28} />
          </radialGradient>
        </defs>
        <rect className="board-bg" x={0} y={0} width={state.board.w} height={state.board.h} rx={0.2} />
        {state.place && <PlaceLayer place={state.place} />}
        <rect className="board-tex" x={0} y={0} width={state.board.w} height={state.board.h} fill="url(#board-stains)" />
        <rect className="board-tex" x={0} y={0} width={state.board.w} height={state.board.h} fill="url(#board-grain)" />
        <rect className="board-vignette" x={0} y={0} width={state.board.w} height={state.board.h} fill="url(#board-vignette)" />

        {[highlight, local].map((h, i) =>
          h ? (
            <g key={i} className={i === 1 ? 'local-highlight' : ''}>
              {h.far > h.near && <circle className={`highlight ${h.kind} far`} cx={h.at.x} cy={h.at.y} r={h.far} strokeWidth={1.5 * px} />}
              <circle
                className={`highlight ${h.kind}`}
                cx={h.at.x}
                cy={h.at.y}
                r={Math.max(h.near, 0.01)}
                strokeWidth={2 * px}
                strokeDasharray={i === 1 ? `${8 * px} ${6 * px}` : undefined}
                data-testid={i === 1 ? 'local-highlight' : 'highlight'}
              />
            </g>
          ) : null,
        )}
        {areaShapes.map(({ area, d }) => (
          <path key={area.id} className="area" d={d} strokeWidth={1.5 * px} data-testid={`area-${area.label}`} />
        ))}
        {previewPath && <path className="area preview" d={previewPath} strokeWidth={2 * px} data-testid="area-preview" />}
        {state.place && <EntranceMarkers place={state.place} scale={camera.scale} selectedId={selectedEntranceId} onTap={onTapMap ? undefined : onTapEntrance} />}
        {drag && dragInfo && (
          <line className={`move-line ${dragInfo.over || dragInfo.blocked ? 'over' : ''}`} x1={drag.from.x} y1={drag.from.y} x2={drag.at.x} y2={drag.at.y} strokeWidth={4 * px} />
        )}

        {state.tokens.map((token) => {
          const dragging = drag?.id === token.id;
          const at = dragging ? drag.at : posOf(token);
          const rotation = faceSeats && token.kind === 'player' ? SIDE_ROTATION[seatSide(token.ownerId)] : 0;
          const selected = selectedTokenId === token.id;
          const conditions = token.conditions ?? [];
          const down = conditions.includes('unconscious');
          const hp = token.stats?.hp;
          return (
            <g
              key={token.id}
              className={`token ${token.kind} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${canDrag(token) ? 'draggable' : ''} ${currentTokenId === token.id ? 'current' : ''} ${down ? 'down' : ''}`}
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
              {currentTokenId === token.id && <circle r={0.58} className="turn-ring" />}
              {down && <path d="M-0.25,-0.25L0.25,0.25M0.25,-0.25L-0.25,0.25" className="down-cross" />}
              {conditions.length > 0 && (
                <text className="condition-label" transform={`rotate(${rotation})`} dy="0.78" fontSize={0.17}>
                  {conditions.filter((c) => c !== 'unconscious').slice(0, 2).join(', ')}
                </text>
              )}
              {showHp && hp && (
                <g transform="translate(-0.4 -0.62)">
                  <rect className="hp-bar-bg" width={0.8} height={0.09} rx={0.04} />
                  <rect className="hp-bar" width={0.8 * Math.max(0, hp.current / hp.max)} height={0.09} rx={0.04} />
                </g>
              )}
            </g>
          );
        })}

        {areaShapes.map(({ area }) => {
          const at = area.shape === 'emanation' || area.shape === 'cone' || area.shape === 'line' ? area.origin : area.target;
          const caster = state.tokens.find((t) => t.id === area.tokenId);
          const rot = faceSeats && caster?.kind === 'player' ? SIDE_ROTATION[seatSide(caster.ownerId)] : 0;
          return (
            <text key={area.id} className="area-label" x={at.x} y={at.y} transform={`rotate(${rot} ${at.x} ${at.y})`} fontSize={0.34} dy="-0.62">
              {area.label}
            </text>
          );
        })}
        {drag && dragInfo && (
          <g transform={`translate(${drag.at.x} ${drag.at.y - 0.8})`}>
            <rect className={`distance-tag ${dragInfo.over || dragInfo.blocked ? 'over' : ''}`} x={-1.3} y={-0.24} width={2.6} height={0.44} rx={0.22} />
            <text className="distance-text" dy="0.02" fontSize={0.26}>
              {dragInfo.blocked ? 'Someone is there' : `${formatDistance(Math.round(dragInfo.ft), unit)}${dragInfo.over ? ' · over speed' : ''}`}
            </text>
          </g>
        )}
        {tool?.overlay?.(px)}
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
            <rect className="frame" x={tableArea.center.x - tableArea.w / 2} y={tableArea.center.y - tableArea.h / 2} width={tableArea.w} height={tableArea.h} strokeWidth={4 * px} />
            {/* the handle: grab it to move what the Main Screen shows */}
            <rect className="handle" x={tableArea.center.x - tableArea.w / 2} y={tableArea.center.y - tableArea.h / 2} width={190 * px} height={30 * px} rx={4 * px} />
            <text className="handle-text" x={tableArea.center.x - tableArea.w / 2 + 10 * px} y={tableArea.center.y - tableArea.h / 2 + 20 * px} fontSize={13 * px}>
              Main Screen · drag to move
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
