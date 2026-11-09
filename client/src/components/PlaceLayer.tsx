import { memo } from 'react';
import type { Entrance, Feature, Place } from '../../../shared/places.ts';
import type { Point } from '../../../shared/geometry.ts';

const pts = (list: Point[]) => list.map((p) => `${p.x},${p.y}`).join(' ');

const ICON: Record<Entrance['kind'], string> = { building: '⌂', cave: '▲', deeper: '▼', exit: '↩' };

/**
 * The drawn map of a place: ground, roads, rivers, buildings, rooms, cave walls...
 * Colours come from CSS (see `.place-*` in styles.css) so both styles and both themes work.
 */
export const PlaceLayer = memo(function PlaceLayer({ place }: { place: Place }) {
  const { w, h } = place.size;
  const by = <T extends Feature['t']>(t: T) => place.features.filter((f): f is Extract<Feature, { t: T }> => f.t === t);
  const big = place.kind === 'village';
  return (
    <g className={`place place-${place.kind}`} pointerEvents="none">
      {place.ground !== 'paper' && <rect className={`place-ground ground-${place.ground}`} x={0} y={0} width={w} height={h} />}
      {by('field').map((f, i) => (
        <polygon key={`fi${i}`} className="place-field" points={pts(f.poly)} />
      ))}
      {by('water').map((f, i) => (
        <g key={`wa${i}`}>
          <polyline className="place-water-bank" points={pts(f.pts)} strokeWidth={f.w + 0.5} />
          <polyline className="place-water" points={pts(f.pts)} strokeWidth={f.w} />
        </g>
      ))}
      {by('road').map((f, i) => (
        <polyline key={`ro${i}`} className="place-road-edge" points={pts(f.pts)} strokeWidth={f.w + 0.35} />
      ))}
      {by('road').map((f, i) => (
        <polyline key={`ri${i}`} className="place-road" points={pts(f.pts)} strokeWidth={f.w} />
      ))}
      {by('square').map((f, i) => (
        <polygon key={`sq${i}`} className="place-square" points={pts(f.poly)} />
      ))}
      {by('bridge').map((f, i) => (
        <g key={`br${i}`}>
          <line className="place-bridge-edge" x1={f.a.x} y1={f.a.y} x2={f.b.x} y2={f.b.y} strokeWidth={f.w + 0.3} />
          <line className="place-bridge" x1={f.a.x} y1={f.a.y} x2={f.b.x} y2={f.b.y} strokeWidth={f.w} />
        </g>
      ))}
      {/* Caves: the floor drawn with round strokes, so the blocky cells read as rough rock walls */}
      {by('cells').map((f, i) => (
        <path key={`ce${i}`} className="place-cave-floor" d={f.d} />
      ))}
      {by('floor').map((f, i) => (
        <polygon key={`fl${i}`} className="place-floor" points={pts(f.poly)} />
      ))}
      {by('rock').map((f, i) => (
        <polygon key={`rk${i}`} className="place-rock" points={pts(f.poly)} />
      ))}
      {by('tree').map((f, i) => (
        <circle key={`tr${i}`} className="place-tree" cx={f.x} cy={f.y} r={f.r} />
      ))}
      {by('building').map((f, i) => (
        <polygon key={`bu${i}`} className={`place-building b-${f.type} ${f.ruined ? 'ruined' : ''}`} points={pts(f.poly)} />
      ))}
      {by('fence').map((f, i) => (
        <polyline key={`fe${i}`} className="place-fence" points={pts(f.pts)} />
      ))}
      {by('well').map((f, i) => (
        <circle key={`we${i}`} className="place-well" cx={f.x} cy={f.y} r={0.6} />
      ))}
      {place.kind !== 'village' &&
        place.walls.map(([x1, y1, x2, y2], i) => <line key={`wl${i}`} className="place-wall" x1={x1} y1={y1} x2={x2} y2={y2} />)}
      {by('furniture').map((f, i) => {
        const round = f.kind === 'barrel' || f.kind === 'hay' || f.kind === 'rubble';
        return round ? (
          <ellipse key={`fu${i}`} className={`place-furniture f-${f.kind}`} cx={f.x} cy={f.y} rx={f.w / 2} ry={f.h / 2} />
        ) : (
          <rect key={`fu${i}`} className={`place-furniture f-${f.kind}`} x={f.x - f.w / 2} y={f.y - f.h / 2} width={f.w} height={f.h} rx={0.12} transform={f.a ? `rotate(${(f.a * 180) / Math.PI} ${f.x} ${f.y})` : undefined} />
        );
      })}
      {by('building')
        .filter((f) => f.label)
        .map((f, i) => {
          const c = f.poly.reduce((a, p) => ({ x: a.x + p.x / f.poly.length, y: a.y + p.y / f.poly.length }), { x: 0, y: 0 });
          return (
            <text key={`bl${i}`} className="place-label pl-small" x={c.x} y={c.y} fontSize={0.55} dy="0.2">
              {f.label}
            </text>
          );
        })}
      {by('label').map((f, i) => (
        <text key={`la${i}`} className={`place-label ${big ? 'pl-title' : 'pl-room'}`} x={f.x} y={f.y} fontSize={big ? 1.8 : 0.42} dy={big ? '0.6' : '0.15'}>
          {big ? f.text : f.text.toUpperCase()}
        </text>
      ))}
    </g>
  );
});

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
  // Markers keep a readable size on screen, but never shrink below their map size.
  const r = Math.max(0.42, 11 / scale);
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
          <circle r={r} className="entrance-dot" />
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
