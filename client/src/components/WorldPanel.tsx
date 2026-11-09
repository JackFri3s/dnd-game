import { useEffect, useState } from 'react';
import type { Requests, RoomState } from '../../../shared/protocol.ts';
import type { Point } from '../../../shared/geometry.ts';
import { BUILDING_TYPES, MOODS, PLACE_KINDS, type BuildingType, type Entrance, type Npc, type Place, type PlaceContext, type PlaceKind, type PlaceSummary } from '../../../shared/places.ts';
import { NPC_ROLES, generateFor, generatePlace, randomNpc } from '../../../shared/generate.ts';
import { newSeed } from '../../../shared/random.ts';
import type { GameStore } from '../game.ts';
import { monsterStats, useMonsters } from './Combat.tsx';

/** A place made on the DM's device only, shown on their map until they use it (or roll another). */
export interface PlacePreview {
  args: Requests['place:generate']['args'];
  place: Place;
}

const KIND_LABEL: Record<PlaceKind, string> = { village: 'Village', building: 'Building', cave: 'Cave', dungeon: 'Dungeon', blank: 'Empty map' };
const ENTRANCE_LABEL: Record<Entrance['kind'], string> = { building: 'Door', cave: 'Cave', deeper: 'Stairs down', exit: 'Way out' };

/** Makes a preview: exactly what the server will make from the same arguments. */
export function makePreview(args: Requests['place:generate']['args'], here: Place | undefined): PlacePreview {
  const entrance = args.entranceId ? here?.entrances.find((e) => e.id === args.entranceId) : undefined;
  const made = entrance && here ? generateFor(entrance, here, args.seed, args.context) : generatePlace(args.kind, args.seed, args.context, args.name || undefined, args.building);
  return { args, place: { ...made, ...(args.name && entrance ? { name: args.name } : {}), id: 'preview', parentId: here && entrance ? here.id : null, parentEntranceId: entrance?.id ?? null } };
}

/** The DM's World tab: the place the party is in, its doors and people, and making new places. */
export function WorldPanel({
  store,
  state,
  preview,
  onPreview,
  selectedEntranceId,
  onSelectEntrance,
  onFocus,
  onEdit,
}: {
  store: GameStore;
  state: RoomState;
  onEdit: () => void;
  preview: PlacePreview | null;
  onPreview: (p: PlacePreview | null) => void;
  selectedEntranceId: string | null;
  onSelectEntrance: (id: string | null) => void;
  onFocus: (at: Point) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'here' | 'new' | 'all'>('here');
  const place = state.place;
  // Arriving somewhere new: show what's here.
  useEffect(() => setTab('here'), [state.placeId]);
  const run = async (p: Promise<unknown>) => {
    setBusy(true);
    try {
      await p;
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const partyLevel = Math.max(1, Math.round(avg(state.characters.filter((c) => c.ownerId).map((c) => c.level)) || 1));

  if (preview) {
    const p = preview.place;
    const fromEntrance = !!preview.args.entranceId;
    return (
      <div className="stack-sm" data-testid="place-preview">
        <div className="selected-head">
          <div className="grow">
            <strong>{p.name}</strong>
            <div className="hint">
              Preview · {KIND_LABEL[p.kind].toLowerCase()} · {p.size.w * 5} × {p.size.h * 5} ft · only you can see this
            </div>
          </div>
        </div>
        <PlaceFacts place={p} />
        <div className="button-row">
          <button className="button" disabled={busy} onClick={() => onPreview(makePreview({ ...preview.args, seed: newSeed() }, place))} data-testid="preview-reroll">
            ↻ Another one
          </button>
          <button className="button" disabled={busy} onClick={() => onPreview(null)}>
            Cancel
          </button>
        </div>
        <div className="button-row">
          <button
            className="button primary"
            disabled={busy}
            data-testid="preview-use"
            onClick={async () => {
              if (await run(store.request('place:generate', { ...preview.args, go: true }))) {
                onPreview(null);
                onSelectEntrance(null);
              }
            }}
          >
            {fromEntrance ? 'Use it and go in' : 'Use it and take the party there'}
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              if (await run(store.request('place:generate', { ...preview.args, go: false }))) onPreview(null);
            }}
          >
            Keep it for later
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="stack-sm" data-testid="world-panel">
      <div className="segmented">
        <button className={tab === 'here' ? 'on' : ''} onClick={() => setTab('here')}>Here</button>
        <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')} data-testid="world-new">New place</button>
        <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All places ({state.places.length})</button>
      </div>
      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {tab === 'here' && place && (
        <HereTab
          store={store}
          state={state}
          place={place}
          run={run}
          busy={busy}
          partyLevel={partyLevel}
          onPreview={onPreview}
          selectedEntranceId={selectedEntranceId}
          onSelectEntrance={onSelectEntrance}
          onFocus={onFocus}
          onEdit={onEdit}
        />
      )}
      {tab === 'new' && <NewPlaceForm partyLevel={partyLevel} onPreview={(args) => onPreview(makePreview(args, place))} />}
      {tab === 'all' && <AllPlaces store={store} state={state} run={run} busy={busy} />}
    </div>
  );
}

function PlaceFacts({ place }: { place: Place }) {
  const doors = place.entrances.filter((e) => e.kind !== 'exit').length;
  const monsters = place.encounters?.reduce((n, e) => n + e.count, 0) ?? 0;
  return (
    <p className="hint">
      {[doors && `${doors} way${doors === 1 ? '' : 's'} in`, place.npcs.length && `${place.npcs.length} ${place.npcs.length === 1 ? 'person' : 'people'}`, monsters && `${monsters} monster${monsters === 1 ? '' : 's'} waiting`]
        .filter(Boolean)
        .join(' · ') || 'Nothing in it yet.'}
    </p>
  );
}

function HereTab({
  store,
  state,
  place,
  run,
  busy,
  partyLevel,
  onPreview,
  selectedEntranceId,
  onSelectEntrance,
  onFocus,
  onEdit,
}: {
  store: GameStore;
  state: RoomState;
  onEdit: () => void;
  place: Place;
  run: (p: Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  partyLevel: number;
  onPreview: (p: PlacePreview | null) => void;
  selectedEntranceId: string | null;
  onSelectEntrance: (id: string | null) => void;
  onFocus: (at: Point) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const parent = place.parentId ? state.places.find((p) => p.id === place.parentId) : undefined;
  const selected = place.entrances.find((e) => e.id === selectedEntranceId);
  const monsters = useMonsters();
  const update = (args: Omit<Requests['place:update']['args'], 'placeId'>) => run(store.request('place:update', { placeId: place.id, ...args }));

  const makeInside = (e: Entrance) => onPreview(makePreview({ kind: 'blank', seed: newSeed(), context: { ...place.context, level: partyLevel }, entranceId: e.id }, place));
  const goThrough = (e: Entrance) => run(store.request('place:enter', { entranceId: e.id })).then((ok) => ok && onSelectEntrance(null));

  async function putOnMap(npc: Npc) {
    const door = place.entrances.find((e) => e.id === npc.entranceId);
    await run(store.request('token:add', { name: npc.name.split(' ')[0], kind: 'npc', color: '#808080', ...(door ? { x: door.x, y: door.y } : {}) }));
  }

  async function placeMonsters(i: number) {
    const enc = place.encounters![i];
    const m = monsters?.find((x) => x.index === enc.monster);
    if (!m) return;
    const ok = await run(
      (async () => {
        for (let n = 1; n <= enc.count; n++) {
          await store.request('token:add', { name: enc.count > 1 ? `${m.name} ${n}` : m.name, kind: 'monster', color: '#4d4d4d', x: enc.x, y: enc.y, stats: monsterStats(m), speedFt: m.speed.walk ?? 30 });
        }
        await store.request('place:update', { placeId: place.id, encounters: place.encounters!.filter((_, j) => j !== i) });
      })(),
    );
    if (ok) onFocus(enc);
  }

  return (
    <>
      <div className="selected-head">
        <div className="grow">
          {renaming !== null ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                update({ name: renaming }).then(() => setRenaming(null));
              }}
            >
              <input value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={60} aria-label="Place name" autoFocus />
              <button className="button small primary">Save</button>
            </form>
          ) : (
            <strong data-testid="place-name">{place.name}</strong>
          )}
          <div className="hint">
            {KIND_LABEL[place.kind]}
            {parent ? ` in ${parent.name}` : ''} · {place.context.mood}
          </div>
        </div>
        {renaming === null && (
          <button className="button small" onClick={() => setRenaming(place.name)}>
            Rename
          </button>
        )}
      </div>
      <button className="button block" onClick={onEdit} data-testid="edit-map">
        ✎ Edit the map
      </button>
      {parent && (
        <button className="button block" disabled={busy} onClick={() => run(store.request('place:go', { placeId: parent.id }))} data-testid="go-parent">
          ↩ Take the party back to {parent.name}
        </button>
      )}

      {selected && (
        <div className="card stack-sm" data-testid="entrance-card">
          <div className="selected-head">
            <div className="grow">
              <strong>{selected.name}</strong>
              <div className="hint">
                {ENTRANCE_LABEL[selected.kind]}
                {selected.hidden ? ' · hidden from players' : ''}
                {selected.kind !== 'exit' && !selected.targetId ? ' · nothing made inside yet' : ''}
              </div>
            </div>
            <button className="icon-btn" onClick={() => onSelectEntrance(null)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="button-row">
            {selected.kind === 'exit' || selected.targetId ? (
              <button className="button primary" disabled={busy} onClick={() => goThrough(selected)} data-testid="entrance-go">
                {selected.kind === 'exit' ? 'Take the party out' : 'Take the party in'}
              </button>
            ) : (
              <button className="button primary" onClick={() => makeInside(selected)} data-testid="entrance-make">
                Make what's inside
              </button>
            )}
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                const name = prompt('Name', selected.name);
                if (name) update({ entrance: { entranceId: selected.id, name } });
              }}
            >
              Rename
            </button>
            {selected.kind !== 'exit' && (
              <button className="button" disabled={busy} onClick={() => update({ entrance: { entranceId: selected.id, hidden: !selected.hidden } })}>
                {selected.hidden ? 'Show to players' : 'Hide from players'}
              </button>
            )}
          </div>
        </div>
      )}

      <h4 className="section-label">Ways in and out ({place.entrances.length})</h4>
      {place.entrances.length === 0 ? (
        <p className="hint">No doors or caves on this map.</p>
      ) : (
        <ul className="list compact">
          {place.entrances.map((e) => (
            <li key={e.id}>
              <button
                className="text-button grow"
                onClick={() => {
                  onSelectEntrance(e.id);
                  onFocus(e);
                }}
              >
                {e.name}
                <span className="hint">
                  {' '}
                  · {ENTRANCE_LABEL[e.kind].toLowerCase()}
                  {e.hidden ? ' · hidden' : ''}
                </span>
              </button>
              {e.kind === 'exit' || e.targetId ? (
                <button className="button small" disabled={busy} onClick={() => goThrough(e)}>
                  {e.kind === 'exit' ? 'Go out' : 'Go in'}
                </button>
              ) : (
                <button className="button small" onClick={() => makeInside(e)}>
                  Make
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4 className="section-label">People here ({place.npcs.length})</h4>
      {place.npcs.map((n) => (
        <NpcCard
          key={n.id}
          npc={n}
          home={place.entrances.find((e) => e.id === n.entranceId)?.name}
          busy={busy}
          onPut={() => putOnMap(n)}
          onRemove={() => update({ npcs: place.npcs.filter((x) => x.id !== n.id) })}
          onSave={(next) => update({ npcs: place.npcs.map((x) => (x.id === n.id ? next : x)) })}
        />
      ))}
      <button
        className="button block"
        disabled={busy}
        onClick={() => update({ npcs: [...place.npcs, randomNpc(newSeed(), NPC_ROLES[Math.floor(Math.random() * NPC_ROLES.length)], place.context)] })}
        data-testid="add-npc"
      >
        + Add a person
      </button>

      {!!place.encounters?.length && (
        <>
          <h4 className="section-label">Monsters waiting here</h4>
          <ul className="list compact">
            {place.encounters.map((enc, i) => (
              <li key={i}>
                <button className="text-button grow" onClick={() => onFocus(enc)}>
                  {enc.count} × {monsters?.find((m) => m.index === enc.monster)?.name ?? enc.monster}
                </button>
                <button className="button small primary" disabled={busy || !monsters} onClick={() => placeMonsters(i)} data-testid="place-monsters">
                  Put on the map
                </button>
                <button className="icon-btn" disabled={busy} onClick={() => update({ encounters: place.encounters!.filter((_, j) => j !== i) })} aria-label="Remove">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="section-label">Notes</h4>
      <Notes key={place.id} text={place.context.description} onSave={(description) => update({ description })} />
    </>
  );
}

function Notes({ text, onSave }: { text: string; onSave: (t: string) => void }) {
  const [value, setValue] = useState(text);
  return (
    <textarea
      rows={3}
      value={value}
      placeholder="What this place is about (only you see this)"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== text && onSave(value)}
      maxLength={500}
    />
  );
}

function NpcCard({ npc, home, busy, onPut, onRemove, onSave }: { npc: Npc; home?: string; busy: boolean; onPut: () => void; onRemove: () => void; onSave: (n: Npc) => void }) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<Npc | null>(null);
  return (
    <div className="expandable">
      <button className="expandable-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <strong>{npc.name}</strong>
        <span className="hint grow">
          {npc.role}
          {home ? ` · ${home}` : ''}
        </span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="expandable-body stack-sm">
          {edit ? (
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                onSave(edit);
                setEdit(null);
              }}
            >
              {(['name', 'role', 'personality', 'look', 'secret'] as const).map((k) => (
                <label key={k} className="stack-sm">
                  <span className="field-label">{k}</span>
                  <input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                </label>
              ))}
              <div className="button-row">
                <button className="button primary">Save</button>
                <button type="button" className="button" onClick={() => setEdit(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p>
                <span className="field-label">Personality</span> {npc.personality}
              </p>
              <p>
                <span className="field-label">Look</span> {npc.look}
              </p>
              <p>
                <span className="field-label">Secret</span> {npc.secret}
              </p>
              <div className="button-row">
                <button className="button small primary" disabled={busy} onClick={onPut}>
                  Put on the map
                </button>
                <button className="button small" onClick={() => setEdit(npc)}>
                  Edit
                </button>
                <button className="button small danger" disabled={busy} onClick={() => confirm(`Remove ${npc.name}?`) && onRemove()}>
                  Remove
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NewPlaceForm({ partyLevel, onPreview }: { partyLevel: number; onPreview: (args: Requests['place:generate']['args']) => void }) {
  const [kind, setKind] = useState<PlaceKind>('village');
  const [building, setBuilding] = useState<BuildingType>('inn');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mood, setMood] = useState('peaceful');
  const [size, setSize] = useState<PlaceContext['size']>('medium');
  const [level, setLevel] = useState(partyLevel);
  return (
    <form
      className="stack-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onPreview({ kind, building, name: name.trim() || undefined, seed: newSeed(), context: { description, mood, size, level } });
      }}
      data-testid="new-place-form"
    >
      <div className="segmented">
        {PLACE_KINDS.map((k) => (
          <button type="button" key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      {kind === 'building' && (
        <label className="inline-label">
          Kind of building
          <select value={building} onChange={(e) => setBuilding(e.target.value as BuildingType)}>
            {BUILDING_TYPES.map((b) => (
              <option key={b.type} value={b.type}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (leave empty for a random one)" maxLength={60} aria-label="Name" />
      <textarea
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe it, e.g. “a fishing village by a river, near an old mine, people are afraid of the woods”. Words like river, mine, walled, market, farms, temple, haunted or abandoned change what's made."
        maxLength={500}
        aria-label="Description"
      />
      <label className="inline-label">
        Mood
        <select value={mood} onChange={(e) => setMood(e.target.value)}>
          {MOODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <div className="segmented">
        {(['small', 'medium', 'large'] as const).map((s) => (
          <button type="button" key={s} className={size === s ? 'on' : ''} onClick={() => setSize(s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <label className="inline-label">
        Party level (for monsters)
        <input type="number" min={1} max={20} value={level} onChange={(e) => setLevel(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} style={{ width: 80 }} />
      </label>
      <button className="button primary block" data-testid="preview-place">
        Make a preview
      </button>
      <p className="hint">You see the preview first. Roll another until you like it; players only see it once you use it.</p>
    </form>
  );
}

function AllPlaces({ store, state, run, busy }: { store: GameStore; state: RoomState; run: (p: Promise<unknown>) => Promise<boolean>; busy: boolean }) {
  // Show the places as a tree: villages, with their buildings and caves inside.
  const children = (id: string | null) => state.places.filter((p) => p.parentId === id || (id === null && p.parentId && !state.places.some((q) => q.id === p.parentId)));
  const rows: { p: PlaceSummary; depth: number }[] = [];
  const walk = (id: string | null, depth: number) => {
    for (const p of children(id)) {
      rows.push({ p, depth });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <ul className="list compact" data-testid="all-places">
      {rows.map(({ p, depth }) => (
        <li key={p.id} style={{ paddingLeft: depth * 16 }}>
          <span className="grow">
            {p.name}
            <span className="hint"> · {KIND_LABEL[p.kind].toLowerCase()}</span>
          </span>
          {p.id === state.placeId ? (
            <span className="pill">Party is here</span>
          ) : (
            <>
              <button className="button small" disabled={busy} onClick={() => run(store.request('place:go', { placeId: p.id }))}>
                Go
              </button>
              <button
                className="icon-btn"
                disabled={busy}
                aria-label={`Delete ${p.name}`}
                onClick={() => confirm(`Delete ${p.name} and everything inside it? Monsters and NPCs there are removed too.`) && run(store.request('place:delete', { placeId: p.id }))}
              >
                ✕
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function avg(list: number[]) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
}
