import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../../../shared/geometry.ts';
import { BUILDING_TYPES, type BuildingType, type Entrance, type Feature, type FloorMaterial, type Place, type Roof } from '../../../shared/places.ts';
import type { GameStore } from '../game.ts';
import type { MapTool } from './MapBoard.tsx';
import { cutDoor, edgesOf, frameOf, nearestWall, newEntranceId, pick, rectPoly, removeFeature, snapToWalls, transformFeature, type Frame, type MapData } from '../map/edit.ts';

type ToolKind = 'select' | 'draw' | 'wall' | 'door' | 'add' | 'entrance' | 'erase';

const ROOFS: { roof: Roof; label: string }[] = [
  { roof: 'wood', label: 'Wooden shingles' },
  { roof: 'slate', label: 'Slate' },
  { roof: 'thatch', label: 'Thatch' },
];
const MATERIALS: { material: FloorMaterial; label: string }[] = [
  { material: 'wood', label: 'Wooden boards' },
  { material: 'stone', label: 'Rough stone' },
  { material: 'flag', label: 'Flagstones' },
  { material: 'tile', label: 'Tiles' },
  { material: 'earth', label: 'Packed earth' },
  { material: 'cave', label: 'Cave floor' },
];
const RUG_COLORS = ['#8b3a3a', '#3a5a8b', '#6b4f2a', '#4f6b3a', '#7a4a7a'];

/** Things the DM can put down, per kind of map. */
const OUTDOOR_ITEMS: Record<string, (at: Point) => Feature> = {
  Tree: (at) => ({ t: 'tree', ...at, r: 1.5 }),
  'Small tree': (at) => ({ t: 'tree', ...at, r: 0.9 }),
  Rock: (at) => ({ t: 'rock', poly: blob(at, 1) }),
  Well: (at) => ({ t: 'well', ...at }),
  'Market stall': (at) => ({ t: 'stall', ...at, w: 2.2, h: 1.6, a: 0, color: '#b5523b' }),
  Fence: (at) => ({ t: 'fence', pts: [{ x: at.x - 2, y: at.y }, { x: at.x + 2, y: at.y }] }),
};
const furniture = (kind: string, w: number, h: number) => (at: Point): Feature => ({ t: 'furniture', kind, ...at, w, h, a: 0 });
const INDOOR_ITEMS: Record<string, (at: Point) => Feature> = {
  Table: furniture('table', 2, 1.4),
  Chair: furniture('chair', 0.55, 0.55),
  Bed: furniture('bed', 1.2, 2),
  Barrel: furniture('barrel', 0.9, 0.9),
  Crate: furniture('crate', 1, 1),
  Chest: furniture('chest', 1, 0.6),
  Shelf: furniture('shelf', 2, 0.5),
  Hearth: furniture('hearth', 1.6, 0.8),
  Bar: furniture('bar', 4, 1),
  Altar: furniture('altar', 2.4, 1.2),
  Pew: furniture('pew', 3, 0.6),
  Throne: furniture('throne', 1.3, 1.2),
  Sarcophagus: furniture('sarcophagus', 1.2, 2.4),
  'Hay bale': furniture('hay', 2, 1.4),
  Rug: (at) => ({ t: 'rug', ...at, w: 3, h: 2, a: 0, color: RUG_COLORS[0] }),
  Pillar: (at) => ({ t: 'column', ...at, r: 0.4 }),
  Statue: (at) => ({ t: 'column', ...at, r: 0.7, round: true }),
  Stairs: (at) => ({ t: 'stairs', ...at, w: 2, h: 2, a: Math.PI / 2 }),
  Puddle: (at) => ({ t: 'puddle', poly: blob(at, 1.2), kind: 'water' }),
  Rubble: (at) => ({ t: 'debris', ...at, r: 0.6 }),
  Rock: (at) => ({ t: 'rock', poly: blob(at, 0.6) }),
};
const ENTRANCES: { kind: Entrance['kind']; label: string; name: string }[] = [
  { kind: 'building', label: 'Door into a building', name: 'New door' },
  { kind: 'cave', label: 'Cave mouth', name: 'Cave' },
  { kind: 'deeper', label: 'Stairs or trapdoor down', name: 'Stairs down' },
  { kind: 'exit', label: 'Way out', name: 'Way out' },
];

function blob(c: Point, r: number): Point[] {
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    const rad = r * (0.8 + 0.3 * Math.sin(i * 2.3));
    return { x: c.x + Math.cos(a) * rad, y: c.y + Math.sin(a) * rad };
  });
}

/** Things that block movement get walls around them. */
function wallsFor(f: Feature): number[][] {
  if (f.t === 'rock') return edgesOf(f.poly);
  if (f.t === 'column') {
    const r = f.r;
    return edgesOf(f.round ? Array.from({ length: 10 }, (_, k) => ({ x: f.x + Math.cos((k / 10) * Math.PI * 2) * r, y: f.y + Math.sin((k / 10) * Math.PI * 2) * r })) : [
      { x: f.x - r, y: f.y - r },
      { x: f.x + r, y: f.y - r },
      { x: f.x + r, y: f.y + r },
      { x: f.x - r, y: f.y + r },
    ]);
  }
  return [];
}

const rot = (p: Point, a: number) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const corners = (f: Frame) => [
  { x: -f.w / 2, y: -f.h / 2 },
  { x: f.w / 2, y: -f.h / 2 },
  { x: f.w / 2, y: f.h / 2 },
  { x: -f.w / 2, y: f.h / 2 },
].map((p) => {
  const r = rot(p, f.a);
  return { x: r.x + f.x, y: r.y + f.y };
});
const dataOf = (p: Place): MapData => ({ features: p.features, walls: p.walls, entrances: p.entrances });

type Drag =
  | { mode: 'move' | 'rotate'; index: number; start: Point; frame: Frame; data: MapData }
  | { mode: 'corner'; index: number; corner: number; frame: Frame; data: MapData }
  | { mode: 'rect' | 'wall'; start: Point; at: Point };

/**
 * The DM's map editor: a working copy of the place's map, the tools that change it,
 * and undo. Every finished change is saved to the game right away.
 */
export function useMapEditor(store: GameStore, place: Place | undefined, scale: number) {
  const [pending, setPending] = useState<MapData | null>(null);
  const [live, setLive] = useState<MapData | null>(null);
  const [history, setHistory] = useState<MapData[]>([]);
  const [tool, setTool] = useState<ToolKind>('select');
  const [selected, setSelected] = useState<number | null>(null);
  const [building, setBuilding] = useState<BuildingType>('house');
  const [roof, setRoof] = useState<Roof>('wood');
  const [material, setMaterial] = useState<FloorMaterial>('wood');
  const [item, setItem] = useState('');
  const [entranceKind, setEntranceKind] = useState<Entrance['kind']>('building');
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragView, setDragView] = useState<Drag | null>(null);

  // The game sent a new version of the place: it already has our changes in it.
  useEffect(() => setPending(null), [place]);
  useEffect(() => {
    setHistory([]);
    setSelected(null);
  }, [place?.id]);

  const outdoor = place?.kind === 'village' || place?.kind === 'blank';
  const items = outdoor ? OUTDOOR_ITEMS : INDOOR_ITEMS;
  const current: MapData | null = live ?? pending ?? (place ? dataOf(place) : null);
  const view = useMemo(() => (place && current ? { ...place, ...current } : place), [place, current]);
  const slack = 10 / scale;

  function commit(next: MapData) {
    if (!place || !current) return;
    setHistory((h) => [...h.slice(-49), current]);
    setPending(next);
    setLive(null);
    store.request('place:map', { placeId: place.id, ...next }).then(
      () => setError(null),
      (e: Error) => {
        setError(e.message);
        setPending(null);
      },
    );
  }

  function undo() {
    const prev = history[history.length - 1];
    if (!prev || !place) return;
    setHistory((h) => h.slice(0, -1));
    setPending(prev);
    setSelected(null);
    store.request('place:map', { placeId: place.id, ...prev }).catch((e: Error) => setError(e.message));
  }

  const selectedFeature = selected !== null ? current?.features[selected] : undefined;
  const selectedFrame = selectedFeature ? frameOf(selectedFeature) : null;

  const mapTool: MapTool | null = !place || !current
    ? null
    : {
        down(at) {
          const data = current;
          if (tool === 'select') {
            if (selectedFrame && selected !== null) {
              const handle = rot({ x: 0, y: -selectedFrame.h / 2 - 26 / scale }, selectedFrame.a);
              if (Math.hypot(at.x - (selectedFrame.x + handle.x), at.y - (selectedFrame.y + handle.y)) < 14 / scale) {
                drag.current = { mode: 'rotate', index: selected, start: at, frame: selectedFrame, data };
                return true;
              }
              const cs = corners(selectedFrame);
              const corner = cs.findIndex((c) => Math.hypot(at.x - c.x, at.y - c.y) < 14 / scale);
              if (corner >= 0 && selectedFeature?.t !== 'door' && selectedFeature?.t !== 'window' && selectedFeature?.t !== 'well') {
                drag.current = { mode: 'corner', index: selected, corner, frame: selectedFrame, data };
                return true;
              }
            }
            const index = pick(data.features, at, slack);
            if (index === null) {
              setSelected(null);
              return false;
            }
            setSelected(index);
            const frame = frameOf(data.features[index]);
            if (frame) drag.current = { mode: 'move', index, start: at, frame, data };
            return true;
          }
          if (tool === 'draw' || tool === 'wall') {
            const start = tool === 'wall' ? snapToWalls(data.walls, at, slack) : at;
            drag.current = { mode: tool === 'draw' ? 'rect' : 'wall', start, at: start };
            setDragView(drag.current);
            return true;
          }
          if (tool === 'door') {
            const wall = nearestWall(data.walls, at, slack * 1.5);
            if (wall === null) return false;
            commit(cutDoor(data, wall, at, outdoor ? 1 : 1.2));
            return true;
          }
          if (tool === 'add') {
            const make = items[item] ?? Object.values(items)[0];
            const f = make(at);
            commit({ ...data, features: [...data.features, f], walls: [...data.walls, ...wallsFor(f)] });
            setSelected(data.features.length);
            setTool('select');
            return true;
          }
          if (tool === 'entrance') {
            const kind = ENTRANCES.find((e) => e.kind === entranceKind)!;
            commit({ ...data, entrances: [...data.entrances, { id: newEntranceId(data.entrances), name: kind.name, kind: entranceKind, ...(entranceKind === 'building' ? { building: 'house' as const } : {}), x: at.x, y: at.y, targetId: null }] });
            return true;
          }
          if (tool === 'erase') {
            const index = pick(data.features, at, slack);
            if (index !== null) {
              commit(removeFeature(data, index));
              setSelected(null);
              return true;
            }
            const wall = nearestWall(data.walls, at, slack);
            if (wall !== null) {
              commit({ ...data, walls: data.walls.filter((_, i) => i !== wall) });
              return true;
            }
            const entrance = data.entrances.findIndex((e) => Math.hypot(e.x - at.x, e.y - at.y) < Math.max(0.8, slack * 1.5));
            if (entrance >= 0) {
              commit({ ...data, entrances: data.entrances.filter((_, i) => i !== entrance) });
              return true;
            }
            return false;
          }
          return false;
        },
        move(at) {
          const d = drag.current;
          if (!d) return;
          if (d.mode === 'rect' || d.mode === 'wall') {
            drag.current = { ...d, at: d.mode === 'wall' ? snapToWalls(current.walls, at, slack) : at };
            setDragView(drag.current);
            return;
          }
          const t = d as Exclude<Drag, { mode: 'rect' | 'wall' }>;
          const f = t.frame;
          let next: Frame;
          if (t.mode === 'move') {
            next = { ...f, x: f.x + at.x - t.start.x, y: f.y + at.y - t.start.y };
          } else if (t.mode === 'rotate') {
            const turn = Math.atan2(at.y - f.y, at.x - f.x) - Math.atan2(t.start.y - f.y, t.start.x - f.x);
            const step = Math.PI / 12; // snaps to 15°
            next = { ...f, a: Math.round((f.a + turn) / step) * step };
          } else {
            const opposite = corners(f)[((t as Extract<Drag, { mode: 'corner' }>).corner + 2) % 4];
            const local = rot({ x: at.x - opposite.x, y: at.y - opposite.y }, -f.a);
            const kind = current.features[t.index].t;
            const round = kind === 'tree' || kind === 'column' || kind === 'debris';
            let w = Math.max(0.3, Math.abs(local.x));
            let h = Math.max(0.3, Math.abs(local.y));
            if (round) w = h = Math.max(w, h);
            const half = rot({ x: (Math.sign(local.x) * w) / 2, y: (Math.sign(local.y) * h) / 2 }, f.a);
            next = { x: opposite.x + half.x, y: opposite.y + half.y, w, h, a: f.a };
          }
          setLive(transformFeature(t.data, t.index, f, next));
        },
        up(at) {
          const d = drag.current;
          drag.current = null;
          setDragView(null);
          if (!d) return;
          if (d.mode === 'rect') {
            const a = d.start;
            const b = at;
            if (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1) return;
            const poly = rectPoly(a, b);
            if (outdoor) {
              const door = { x: (poly[2].x + poly[3].x) / 2, y: poly[2].y };
              const name = `New ${BUILDING_TYPES.find((t) => t.type === building)?.label.toLowerCase() ?? 'building'}`;
              // Trees where the building now stands are cut down.
              const inside = (f: Feature) => f.t === 'tree' && f.x > poly[0].x - 0.5 && f.x < poly[2].x + 0.5 && f.y > poly[0].y - 0.5 && f.y < poly[2].y + 0.5;
              commit({
                features: [...current.features.filter((f) => !inside(f)), { t: 'building', poly, type: building, roof }, { t: 'door', x: door.x, y: door.y, a: 0, w: 1 }],
                walls: [...current.walls, ...edgesOf(poly)],
                entrances: [...current.entrances, { id: newEntranceId(current.entrances), name, kind: 'building', building, x: door.x, y: door.y + 0.6, targetId: null }],
              });
            } else {
              commit({ ...current, features: [...current.features, { t: 'floor', poly, material }], walls: [...current.walls, ...edgesOf(poly)] });
            }
            return;
          }
          if (d.mode === 'wall') {
            if (Math.hypot(d.at.x - d.start.x, d.at.y - d.start.y) < 0.5) return;
            commit({ ...current, walls: [...current.walls, [d.start.x, d.start.y, d.at.x, d.at.y]] });
            return;
          }
          if (live) commit(live);
        },
        overlay(px) {
          const out = [];
          const f = selectedFeature && live ? live.features[selected!] : selectedFeature;
          const frame = f ? frameOf(f) : null;
          if (tool === 'select' && frame) {
            const cs = corners(frame);
            const handle = rot({ x: 0, y: -frame.h / 2 - 26 * px }, frame.a);
            const top = rot({ x: 0, y: -frame.h / 2 }, frame.a);
            out.push(<polygon key="sel" className="edit-outline" points={cs.map((c) => `${c.x},${c.y}`).join(' ')} />);
            out.push(<line key="stem" className="edit-outline" x1={frame.x + top.x} y1={frame.y + top.y} x2={frame.x + handle.x} y2={frame.y + handle.y} />);
            out.push(<circle key="rot" className="edit-handle" cx={frame.x + handle.x} cy={frame.y + handle.y} r={8 * px} />);
            if (f?.t !== 'door' && f?.t !== 'window' && f?.t !== 'well') cs.forEach((c, i) => out.push(<rect key={`c${i}`} className="edit-handle" x={c.x - 6 * px} y={c.y - 6 * px} width={12 * px} height={12 * px} />));
          }
          if (dragView?.mode === 'rect') {
            const poly = rectPoly(dragView.start, dragView.at);
            out.push(<polygon key="draft" className="edit-draft" points={poly.map((c) => `${c.x},${c.y}`).join(' ')} />);
          }
          if (dragView?.mode === 'wall') out.push(<line key="wall" className="edit-line" x1={dragView.start.x} y1={dragView.start.y} x2={dragView.at.x} y2={dragView.at.y} />);
          return <g className="edit-overlay">{out}</g>;
        },
      };

  function changeSelected(patch: Partial<Feature>) {
    if (selected === null || !current) return;
    const features = current.features.slice();
    features[selected] = { ...features[selected], ...patch } as Feature;
    commit({ ...current, features });
  }

  function rotateSelected() {
    if (selected === null || !current || !selectedFrame) return;
    commit(transformFeature(current, selected, selectedFrame, { ...selectedFrame, a: selectedFrame.a + Math.PI / 2 }));
  }

  function deleteSelected() {
    if (selected === null || !current) return;
    commit(removeFeature(current, selected));
    setSelected(null);
  }

  return {
    view,
    mapTool,
    outdoor,
    tool,
    setTool: (t: ToolKind) => {
      setTool(t);
      if (t !== 'select') setSelected(null);
    },
    items: Object.keys(items),
    item: item || Object.keys(items)[0],
    setItem,
    building,
    setBuilding,
    roof,
    setRoof,
    material,
    setMaterial,
    entranceKind,
    setEntranceKind,
    selectedFeature,
    changeSelected,
    rotateSelected,
    deleteSelected,
    undo,
    canUndo: history.length > 0,
    error,
    clearError: () => setError(null),
  };
}

export type MapEditorState = ReturnType<typeof useMapEditor>;

const TOOLS: { tool: ToolKind; label: string; outdoor?: string; hint: string; hintIndoor?: string }[] = [
  { tool: 'select', label: 'Select', hint: 'Tap something to select it. Drag it to move it, drag a corner to resize it, drag the round handle to turn it.' },
  { tool: 'draw', label: 'Building', outdoor: 'Building', hint: 'Drag on the map to draw a building. It gets a door at the bottom and a way in you can make the inside for.', hintIndoor: 'Drag on the map to draw a room: a floor with walls around it. Use Door to cut doorways.' },
  { tool: 'wall', label: 'Wall', hint: 'Drag to draw a wall. Ends snap to other walls. Walls stop players walking through.' },
  { tool: 'door', label: 'Door', hint: 'Tap a wall to cut a doorway with a door in it.' },
  { tool: 'add', label: 'Add', hint: 'Choose a thing, then tap the map to put it down.' },
  { tool: 'entrance', label: 'Way in', hint: 'Tap the map to add a way into another place (a door, cave, stairs).' },
  { tool: 'erase', label: 'Erase', hint: 'Tap something to remove it: furniture, trees, buildings, walls or ways in.' },
];

/** The editor's controls (in the DM's side panel while editing). */
export function MapEditorPanel({ editor, onDone }: { editor: MapEditorState; onDone: () => void }) {
  const t = TOOLS.find((x) => x.tool === editor.tool)!;
  const f = editor.selectedFeature;
  return (
    <div className="stack-sm" data-testid="map-editor">
      <div className="selected-head">
        <strong className="grow">Editing the map</strong>
        <button className="button small" disabled={!editor.canUndo} onClick={editor.undo} data-testid="edit-undo">
          ↶ Undo
        </button>
        <button className="button small primary" onClick={onDone} data-testid="edit-done">
          Done
        </button>
      </div>
      <div className="tool-grid">
        {TOOLS.map((x) => (
          <button key={x.tool} className={`button small ${editor.tool === x.tool ? 'on' : ''}`} onClick={() => editor.setTool(x.tool)} data-testid={`tool-${x.tool}`}>
            {x.tool === 'draw' && !editor.outdoor ? 'Room' : x.label}
          </button>
        ))}
      </div>
      <p className="hint">{!editor.outdoor && t.hintIndoor ? t.hintIndoor : t.hint}</p>
      {editor.tool === 'draw' && editor.outdoor && (
        <>
          <label className="inline-label">
            Kind
            <select value={editor.building} onChange={(e) => editor.setBuilding(e.target.value as BuildingType)} aria-label="Kind of building">
              {BUILDING_TYPES.map((b) => (
                <option key={b.type} value={b.type}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-label">
            Roof
            <select value={editor.roof} onChange={(e) => editor.setRoof(e.target.value as Roof)}>
              {ROOFS.map((r) => (
                <option key={r.roof} value={r.roof}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {editor.tool === 'draw' && !editor.outdoor && (
        <label className="inline-label">
          Floor
          <select value={editor.material} onChange={(e) => editor.setMaterial(e.target.value as FloorMaterial)}>
            {MATERIALS.map((m) => (
              <option key={m.material} value={m.material}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {editor.tool === 'add' && (
        <div className="chip-row" data-testid="add-items">
          {editor.items.map((name) => (
            <button key={name} className={`chip ${editor.item === name ? 'on' : ''}`} onClick={() => editor.setItem(name)}>
              {name}
            </button>
          ))}
        </div>
      )}
      {editor.tool === 'entrance' && (
        <label className="inline-label">
          Kind
          <select value={editor.entranceKind} onChange={(e) => editor.setEntranceKind(e.target.value as Entrance['kind'])}>
            {ENTRANCES.map((e) => (
              <option key={e.kind} value={e.kind}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {editor.tool === 'select' && f && (
        <div className="card stack-sm" data-testid="edit-selected">
          <strong>{f.t === 'furniture' ? f.kind : f.t === 'building' ? (f.label ?? BUILDING_TYPES.find((b) => b.type === f.type)?.label) : f.t === 'column' ? (f.round ? 'statue' : 'pillar') : f.t}</strong>
          {f.t === 'building' && (
            <>
              <label className="inline-label">
                Kind
                <select value={f.type} onChange={(e) => editor.changeSelected({ type: e.target.value as BuildingType })}>
                  {BUILDING_TYPES.map((b) => (
                    <option key={b.type} value={b.type}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline-label">
                Roof
                <select value={f.roof ?? 'wood'} onChange={(e) => editor.changeSelected({ roof: e.target.value as Roof })}>
                  {ROOFS.map((r) => (
                    <option key={r.roof} value={r.roof}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row check-row">
                <input type="checkbox" checked={!!f.ruined} onChange={(e) => editor.changeSelected({ ruined: e.target.checked || undefined })} /> Ruined
              </label>
            </>
          )}
          {f.t === 'floor' && (
            <label className="inline-label">
              Floor
              <select value={f.material ?? 'wood'} onChange={(e) => editor.changeSelected({ material: e.target.value as FloorMaterial })}>
                {MATERIALS.map((m) => (
                  <option key={m.material} value={m.material}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {f.t === 'field' && (
            <div className="segmented">
              {(['soil', 'green', 'gold'] as const).map((c) => (
                <button key={c} className={(f.crop ?? 'soil') === c ? 'on' : ''} onClick={() => editor.changeSelected({ crop: c })}>
                  {c === 'soil' ? 'Ploughed' : c === 'green' ? 'Young crops' : 'Ripe grain'}
                </button>
              ))}
            </div>
          )}
          {f.t === 'puddle' && (
            <div className="segmented">
              {(['water', 'mud', 'blood'] as const).map((k) => (
                <button key={k} className={(f.kind ?? 'water') === k ? 'on' : ''} onClick={() => editor.changeSelected({ kind: k })}>
                  {k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
          )}
          {(f.t === 'rug' || f.t === 'stall') && (
            <div className="swatches">
              {(f.t === 'rug' ? RUG_COLORS : ['#b5523b', '#3f6fa0', '#c9a23a', '#5d8a4e', '#8b4f8f']).map((c) => (
                <button key={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => editor.changeSelected({ color: c })} aria-label={`Colour ${c}`} />
              ))}
            </div>
          )}
          <div className="button-row">
            <button className="button small" onClick={editor.rotateSelected}>
              ↻ Turn 90°
            </button>
            <button className="button small danger" onClick={editor.deleteSelected} data-testid="edit-delete">
              Remove
            </button>
          </div>
        </div>
      )}
      {editor.error && (
        <p className="error" onClick={editor.clearError}>
          {editor.error}
        </p>
      )}
      <p className="hint">Changes are saved and shown to everyone straight away.</p>
    </div>
  );
}
