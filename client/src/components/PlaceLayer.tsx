import { memo, useMemo, type ReactNode } from 'react';
import type { Entrance, Feature, Place } from '../../../shared/places.ts';
import { drawPlace, type Item } from '../map/art.ts';

const ICON: Record<Entrance['kind'], string> = { building: '⌂', cave: '▲', deeper: '▼', exit: '↩' };
const deg = (a: number) => (a * 180) / Math.PI;

/**
 * The drawn map of a place: a painted village, or an inked interior, cave or dungeon.
 * See map/art.ts for how it's worked out, and `.v-*` / `.i-*` in styles.css for colours.
 */
export const PlaceLayer = memo(function PlaceLayer({ place }: { place: Place }) {
  const drawing = useMemo(() => drawPlace(place), [place]);
  const { w, h } = place.size;
  return (
    <g className={`place place-${place.kind}`} pointerEvents="none">
      <defs>
        <clipPath id="place-clip">
          <rect x={0} y={0} width={w} height={h} />
        </clipPath>
        <FloorPatterns />
      </defs>
      <g clipPath="url(#place-clip)">
        {place.kind !== 'village' && place.kind !== 'blank' && <rect className="i-paper" x={0} y={0} width={w} height={h} />}
        {drawing.layers.map((l, i) =>
          l.d ? <path key={i} d={l.d} className={l.className} style={l.fill ? { fill: l.fill } : undefined} strokeWidth={l.width} /> : null,
        )}
        {drawing.shading && <image href={drawing.shading} x={0} y={0} width={w} height={h} preserveAspectRatio="none" className="v-shading" />}
        {drawing.items.map((item, i) => (
          <ItemView key={i} item={item} />
        ))}
      </g>
    </g>
  );
});

function ItemView({ item }: { item: Item }) {
  if (item.k === 'label') {
    const number = /^\d+$/.test(item.f.text);
    return item.big ? (
      <text className="place-label pl-title" x={item.f.x} y={item.f.y} fontSize={2.2} dy="0.6">
        {item.f.text}
      </text>
    ) : (
      <text className="place-label pl-room" x={item.f.x} y={item.f.y} fontSize={number ? 0.8 : 0.42} dy="0.3">
        {number ? item.f.text : item.f.text.toUpperCase()}
      </text>
    );
  }
  if (item.k === 'buildingLabel') {
    return (
      <text className="place-label pl-small" x={item.x} y={item.y} fontSize={0.6} dy="0.2">
        {item.text}
      </text>
    );
  }
  if (item.k === 'rug') {
    const { x, y, w, h, a, color } = item.f;
    return (
      <g transform={`translate(${x} ${y}) rotate(${deg(a)})`}>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={0.08} fill={color} className="i-rug" />
        <rect x={-w / 2 + 0.25} y={-h / 2 + 0.25} width={w - 0.5} height={h - 0.5} className="i-rug-border" />
        <rect x={-w / 2 + 0.5} y={-h / 2 + 0.5} width={w - 1} height={h - 1} className="i-rug-border thin" />
      </g>
    );
  }
  if (item.k === 'stall') {
    const { x, y, w, h, a, color } = item.f;
    return (
      <g transform={`translate(${x} ${y}) rotate(${deg(a)})`}>
        <rect x={-w / 2 + 0.15} y={-h / 2 + 0.2} width={w} height={h} className="v-item-shadow" />
        <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={color} className="ink-thin" />
        {[-0.25, 0.25].map((k) => (
          <line key={k} x1={w * k} y1={-h / 2} x2={w * k} y2={h / 2} className="stripe" />
        ))}
      </g>
    );
  }
  return <Furniture f={item.f} />;
}

/** One piece of furniture, drawn around its centre. */
function Furniture({ f }: { f: Extract<Feature, { t: 'furniture' }> }) {
  const { w, h } = f;
  const x0 = -w / 2;
  const y0 = -h / 2;
  const box = (cls: string, extra?: ReactNode, rx = 0.08) => (
    <>
      <rect x={x0} y={y0} width={w} height={h} rx={rx} className={cls} />
      {extra}
    </>
  );
  // A colour that stays the same for this piece on every screen.
  const pick = <T,>(list: T[]) => list[Math.abs(Math.round(f.x * 7 + f.y * 13)) % list.length];
  let body: ReactNode;
  switch (f.kind) {
    case 'table':
    case 'long table':
    case 'counter':
    case 'bar':
    case 'workbench':
    case 'desk':
      body = box(
        'fu-wood',
        <>
          {[0.33, 0.66].map((k) => (
            <line key={k} x1={x0 + 0.1} x2={x0 + w - 0.1} y1={y0 + h * k} y2={y0 + h * k} className="fu-grain" />
          ))}
          {f.kind === 'desk' && <rect x={x0 + w * 0.2} y={y0 + h * 0.2} width={w * 0.3} height={h * 0.45} className="fu-paper" />}
          {(f.kind === 'table' || f.kind === 'long table') && <circle cx={w * 0.15} cy={0} r={0.12} className="fu-candle" />}
          {f.kind === 'bar' && [0.2, 0.45, 0.7].map((k) => <circle key={k} cx={x0 + w * k} cy={y0 + h * 0.35} r={0.13} className="fu-mug" />)}
          {f.kind === 'workbench' && <rect x={x0 + w * 0.6} y={y0 + 0.15} width={w * 0.25} height={0.18} className="fu-metal" />}
        </>,
      );
      break;
    case 'chair':
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} rx={0.08} className="fu-wood-dark" />
          <line x1={x0 + 0.05} x2={x0 + w - 0.05} y1={y0 + 0.08} y2={y0 + 0.08} className="fu-ink" />
        </>
      );
      break;
    case 'bed': {
      const blanket = pick(['#8b3a3a', '#3a5a8b', '#4f6b3a', '#8b6f3a', '#6b4a7a']);
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} rx={0.1} className="fu-wood" />
          <rect x={x0 + 0.08} y={y0 + h * 0.3} width={w - 0.16} height={h * 0.66} rx={0.06} fill={blanket} className="ink-thin" />
          <line x1={x0 + 0.08} x2={x0 + w - 0.08} y1={y0 + h * 0.42} y2={y0 + h * 0.42} className="fu-fold" />
          <rect x={x0 + w * 0.15} y={y0 + 0.1} width={w * 0.7} height={h * 0.18} rx={0.08} className="fu-pillow" />
        </>
      );
      break;
    }
    case 'chest':
      body = box(
        'fu-chest',
        <>
          <line x1={x0 + w * 0.25} x2={x0 + w * 0.25} y1={y0} y2={y0 + h} className="fu-band" />
          <line x1={x0 + w * 0.75} x2={x0 + w * 0.75} y1={y0} y2={y0 + h} className="fu-band" />
          <rect x={-0.08} y={y0 + h - 0.2} width={0.16} height={0.16} className="fu-gold" />
        </>,
      );
      break;
    case 'barrel':
      body = (
        <>
          <circle r={w / 2} className="fu-barrel" />
          <circle r={w / 2 - 0.12} className="fu-hoop" />
          <circle r={w / 4} className="fu-hoop" />
        </>
      );
      break;
    case 'urn':
      body = (
        <>
          <circle r={w / 2} className="fu-urn" />
          <circle r={w / 5} className="fu-dark" />
        </>
      );
      break;
    case 'crate':
      body = box(
        'fu-crate',
        <>
          <rect x={x0 + 0.1} y={y0 + 0.1} width={w - 0.2} height={h - 0.2} className="fu-grain-box" />
          <path d={`M${x0 + 0.1},${y0 + 0.1}L${-x0 - 0.1},${-y0 - 0.1}M${-x0 - 0.1},${y0 + 0.1}L${x0 + 0.1},${-y0 - 0.1}`} className="fu-grain-box" />
        </>,
        0.04,
      );
      break;
    case 'sack':
      body = (
        <>
          <ellipse rx={w / 2} ry={h / 2} className="fu-sack" />
          <path d={`M${-w * 0.1},${-h * 0.45}l${w * 0.1},${h * 0.15}l${w * 0.1},${-h * 0.15}`} className="fu-ink" />
        </>
      );
      break;
    case 'shelf':
    case 'rack':
      body = box(
        'fu-wood-dark',
        <>
          {Array.from({ length: Math.max(2, Math.floor((w - 0.1) / 0.35)) }, (_, i) => (
            <rect
              key={i}
              x={x0 + 0.1 + i * 0.35}
              y={y0 + 0.08}
              width={0.22}
              height={Math.max(0.1, h - 0.16)}
              fill={f.kind === 'rack' ? '#8d8d8d' : ['#8b3a3a', '#3a5a8b', '#6b5a2a', '#4f6b3a'][(i * 7 + Math.abs(Math.round(f.x))) % 4]}
              className="ink-thin"
            />
          ))}
        </>,
        0.04,
      );
      break;
    case 'hearth':
    case 'oven':
    case 'forge':
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} rx={0.1} className="fu-stone" />
          <rect x={x0 + w * 0.18} y={y0 + h * 0.25} width={w * 0.64} height={h * 0.55} rx={0.12} className="fu-coals" />
          <ellipse cx={0} cy={y0 + h * 0.52} rx={w * 0.22} ry={h * 0.2} className="fu-fire" />
          <ellipse cx={0} cy={y0 + h * 0.55} rx={w * 0.1} ry={h * 0.1} className="fu-fire-core" />
        </>
      );
      break;
    case 'anvil':
      body = <path d={`M${x0},${y0 + h * 0.2}L${x0 + w},${y0}L${x0 + w * 0.75},${y0 + h}L${x0 + w * 0.25},${y0 + h}Z`} className="fu-iron" />;
      break;
    case 'altar':
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} rx={0.06} className="fu-stone-light" />
          <rect x={x0 + w * 0.3} y={y0 - 0.05} width={w * 0.4} height={h + 0.1} className="fu-cloth" />
          <circle cx={x0 + 0.25} cy={0} r={0.12} className="fu-candle" />
          <circle cx={-x0 - 0.25} cy={0} r={0.12} className="fu-candle" />
        </>
      );
      break;
    case 'pew':
      body = box('fu-wood', <line x1={x0} x2={x0 + w} y1={y0 + h - 0.12} y2={y0 + h - 0.12} className="fu-ink" />, 0.05);
      break;
    case 'throne':
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} rx={0.15} className="fu-gold-wood" />
          <rect x={x0 + 0.2} y={y0 + 0.3} width={w - 0.4} height={h - 0.45} rx={0.1} className="fu-cloth" />
        </>
      );
      break;
    case 'hay':
      body = (
        <>
          <ellipse rx={w / 2} ry={h / 2} className="fu-hay" />
          {[-0.25, 0, 0.25].map((k) => (
            <line key={k} x1={-w * 0.35} x2={w * 0.35} y1={h * k} y2={h * k + 0.1} className="fu-hay-line" />
          ))}
        </>
      );
      break;
    case 'stall':
      body = (
        <>
          <rect x={x0} y={y0} width={w} height={h} className="fu-straw" />
          <path d={`M${x0},${y0 + h}V${y0}H${x0 + w}V${y0 + h}`} className="fu-fence" />
        </>
      );
      break;
    case 'sarcophagus':
      body = (
        <>
          <rect x={x0 + 0.1} y={y0 + 0.15} width={w} height={h} rx={0.2} className="fu-shadow" />
          <rect x={x0} y={y0} width={w} height={h} rx={0.2} className="fu-stone-light" />
          <rect x={x0 + 0.18} y={y0 + 0.18} width={w - 0.36} height={h - 0.36} rx={0.14} className="fu-carving" />
          <path d={`M0,${y0 + h * 0.25}V${y0 + h * 0.65}M${-w * 0.18},${y0 + h * 0.38}H${w * 0.18}`} className="fu-carving" />
        </>
      );
      break;
    case 'bones':
    case 'rubble':
      body = (
        <g className={f.kind === 'bones' ? 'fu-bones' : 'fu-rubble'}>
          {[0, 1, 2, 3].map((i) => {
            const a = i * 1.7 + f.x;
            const cx = Math.cos(a) * w * 0.25;
            const cy = Math.sin(a) * h * 0.25;
            return f.kind === 'bones' ? (
              <line key={i} x1={cx - 0.2} y1={cy - 0.05 * i} x2={cx + 0.2} y2={cy + 0.05 * i} />
            ) : (
              <path key={i} d={`M${cx - w * 0.18},${cy}L${cx},${cy - h * 0.2}L${cx + w * 0.2},${cy + h * 0.05}L${cx + w * 0.02},${cy + h * 0.18}Z`} />
            );
          })}
        </g>
      );
      break;
    default:
      body = box('fu-wood', null);
  }
  return (
    <g transform={`translate(${f.x} ${f.y}) rotate(${deg(f.a)})`} className={`fu fu-${f.kind.replace(/\s+/g, '-')}`}>
      {body}
    </g>
  );
}

/** Floor materials as repeating patterns (in map units, so they scale with the map). */
function FloorPatterns() {
  return (
    <>
      <pattern id="mat-wood" patternUnits="userSpaceOnUse" width={3} height={0.8}>
        <rect width={3} height={0.8} className="m-wood" />
        <path d="M0,0.4H3M0,0.8H3M1.1,0V0.4M2.4,0.4V0.8M0.3,0.4V0.8" className="m-wood-line" />
        <path d="M0.2,0.2H0.9M1.6,0.6H2.2M2.5,0.15H2.9" className="m-wood-grain" />
      </pattern>
      <pattern id="mat-stone" patternUnits="userSpaceOnUse" width={2} height={1.4}>
        <rect width={2} height={1.4} className="m-stone" />
        <rect x={0.05} y={0.05} width={0.9} height={0.6} className="m-stone-2" rx={0.08} />
        <rect x={1.05} y={0.05} width={0.9} height={0.6} className="m-stone-3" rx={0.08} />
        <rect x={0.55} y={0.75} width={0.9} height={0.6} className="m-stone-3" rx={0.08} />
        <rect x={-0.45} y={0.75} width={0.9} height={0.6} className="m-stone-2" rx={0.08} />
        <rect x={1.55} y={0.75} width={0.9} height={0.6} className="m-stone-2" rx={0.08} />
      </pattern>
      <pattern id="mat-flag" patternUnits="userSpaceOnUse" width={2} height={2}>
        <rect width={2} height={2} className="m-flag" />
        <rect x={1} y={0} width={1} height={1} className="m-flag-2" />
        <rect x={0} y={1} width={1} height={1} className="m-flag-3" />
        <path d="M0,0H2M0,1H2M0,0V2M1,0V2" className="m-flag-line" />
      </pattern>
      <pattern id="mat-tile" patternUnits="userSpaceOnUse" width={1} height={1}>
        <rect width={1} height={1} className="m-tile" />
        <rect width={0.5} height={0.5} className="m-tile-2" />
        <rect x={0.5} y={0.5} width={0.5} height={0.5} className="m-tile-2" />
      </pattern>
      <pattern id="mat-earth" patternUnits="userSpaceOnUse" width={2} height={2}>
        <rect width={2} height={2} className="m-earth" />
        <path d="M0.3,0.4h0.05M1.2,0.2h0.05M0.8,1.1h0.05M1.6,1.5h0.05M0.2,1.7h0.05M1.5,0.8h0.05" className="m-earth-dot" />
      </pattern>
      <pattern id="mat-cave" patternUnits="userSpaceOnUse" width={3} height={3}>
        <rect width={3} height={3} className="m-cave" />
        <path d="M0.4,0.6q0.3,-0.2 0.6,0M1.8,1.6q0.3,-0.2 0.6,0M0.9,2.4q0.3,-0.2 0.6,0M2.4,0.4h0.05M0.3,1.5h0.05M1.5,2.7h0.05" className="m-cave-line" />
      </pattern>
    </>
  );
}

/** Doors, cave mouths and stairs: tap one to go through it (or, for players, to ask the DM). */
export function EntranceMarkers({
  place,
  scale,
  selectedId,
  onTap,
}: {
  place: Place;
  scale: number;
  selectedId?: string | null;
  onTap?: (e: Entrance) => void;
}) {
  // Markers keep a tappable size on screen, but get small when zoomed far out.
  const r = Math.max(0.4, Math.min(1.2, 9 / scale));
  const showNames = scale > 14;
  return (
    <g className="entrances">
      {place.entrances.map((e) => (
        <g
          key={e.id}
          className={`entrance ${e.kind} ${e.hidden ? 'hidden' : ''} ${e.targetId ? 'made' : ''} ${selectedId === e.id ? 'selected' : ''} ${onTap ? 'tappable' : ''}`}
          transform={`translate(${e.x} ${e.y})`}
          onPointerDown={(ev) => {
            if (!onTap) return;
            ev.stopPropagation();
            onTap(e);
          }}
          data-testid={`entrance-${e.name}`}
        >
          <circle r={r} className="entrance-dot" strokeWidth={r * 0.2} />
          <text className="entrance-icon" dy="0.36em" fontSize={r * 1.1}>
            {ICON[e.kind]}
          </text>
          {showNames && (
            <text className="entrance-name" dy={r + 0.45} fontSize={Math.max(0.42, 10 / scale)}>
              {e.name}
            </text>
          )}
        </g>
      ))}
      {place.encounters?.map((m, i) => (
        <g key={`enc${i}`} className="encounter-mark" transform={`translate(${m.x} ${m.y})`}>
          <circle r={1.4} className="encounter-ring" />
          <text className="encounter-text" dy="0.2em" fontSize={0.5}>
            {m.count} × {m.monster.replace(/-/g, ' ')}
          </text>
        </g>
      ))}
    </g>
  );
}
