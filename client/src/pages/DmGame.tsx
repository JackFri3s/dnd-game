import { useEffect, useState } from 'react';
import type { Member, RoomState, TokenKind } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { nextPanelSide, usePanelSide } from '../settings.ts';
import { SIDE_ICON } from '../seats.ts';
import { MapBoard, type Camera } from '../components/MapBoard.tsx';
import { CalibrationControls } from '../components/CalibrationControls.tsx';
import { CampaignPanel } from '../components/CampaignPanel.tsx';
import { ActionPanel, AimBar, useAim, useLocalHighlight } from '../components/Actions.tsx';
import { CombatPanel, MonsterBlock, MonsterPicker, RollResult, TargetBar, TokenStatus, combatInfo, useMonsters, useTargeting } from '../components/Combat.tsx';
import { useRules } from '../rules/index.ts';
import { CharacterList } from '../characters/CharacterList.tsx';
import { HomebrewPanel } from '../characters/HomebrewPanel.tsx';
import { seatNumber } from '../seats.ts';
import { WorldPanel, type PlacePreview } from '../components/WorldPanel.tsx';

const TOKEN_SHADES = ['#1a1a1a', '#4d4d4d', '#808080', '#b3b3b3'];
type Panel = 'token' | 'combat' | 'add' | 'world' | 'party' | 'campaign' | 'table';
const PANELS: { id: Panel; label: string }[] = [
  { id: 'token', label: 'Selected' },
  { id: 'combat', label: 'Combat' },
  { id: 'add', label: 'Add' },
  { id: 'world', label: 'World' },
  { id: 'party', label: 'Party' },
  { id: 'campaign', label: 'Campaign' },
  { id: 'table', label: 'Main Screen' },
];

/** The DM's device during play: the whole map, every token, and the controls. */
export function DmGame({ store, state }: { store: GameStore; state: RoomState }) {
  const [camera, setCamera] = useState<Camera>({ ...state.view, scale: 40 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('add');
  const [partyTab, setPartyTab] = useState<'characters' | 'players'>('characters');
  const [campaignTab, setCampaignTab] = useState<'saves' | 'custom'>('saves');
  const [showStats, setShowStats] = useState(true);
  const highlight = useLocalHighlight();
  const [menu, setMenu] = useState(false);
  const side = usePanelSide();
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const selected = state.tokens.find((t) => t.id === selectedId) ?? null;
  const players = state.members.filter((m) => m.role === 'player');
  const table = state.members.find((m) => m.role === 'table');
  const owner = selected?.ownerId ? state.members.find((m) => m.id === selected.ownerId) : null;
  const selectedCharacter = selected?.characterId ? (state.characters.find((c) => c.id === selected.characterId) ?? null) : null;
  const rules = useRules(state.homebrew);
  const aimState = useAim(store, state, highlight);
  const targeting = useTargeting(store, state, highlight);
  const { current, movedFt } = combatInfo(state);
  const monsters = useMonsters();
  const selectedMonster = selected?.stats?.monster ? monsters?.find((m) => m.index === selected.stats!.monster) : undefined;
  const [preview, setPreview] = useState<PlacePreview | null>(null);
  const [entranceId, setEntranceId] = useState<string | null>(null);

  // A new place: look at where the party arrives.
  useEffect(() => {
    setCamera((c) => ({ ...c, ...state.view }));
    setEntranceId(null);
  }, [state.placeId]); // eslint-disable-line react-hooks/exhaustive-deps

  function showPreview(p: PlacePreview | null) {
    setPreview(p);
    if (p) setCamera((c) => ({ ...c, x: p.place.size.w / 2, y: p.place.size.h / 2, scale: Math.min(c.scale, 14) }));
    else setCamera((c) => ({ ...c, ...state.view }));
  }
  // While previewing, the DM's map shows the preview instead of the real place.
  const mapState: RoomState = preview
    ? { ...state, place: preview.place, board: preview.place.size, tokens: [], areas: [], highlight: null }
    : state;

  function kick(p: Member) {
    if (!confirm(`Remove ${p.name} from the game? Their token stays on the map.`)) return;
    run(store.request('dm:kick', { memberId: p.id }));
  }

  return (
    <div className={`game-layout panel-${side}`} data-testid="dm-game">
      <header className="game-bar">
        <div className="grow title-block">
          <strong>{state.campaign?.name ?? 'Dungeon Master'}</strong>
          <span className="hint">
            game {state.code} · <span className={`dot ${table?.connected ? 'on' : 'off'}`} /> Main Screen {table?.connected ? 'on' : 'off'}
          </span>
        </div>
        <button className="button small" onClick={() => setCamera({ ...camera, ...state.view })} title="Centre your map on what the Main Screen shows">
          ◎ Main Screen
        </button>
        <button className="icon-btn" onClick={() => nextPanelSide(side)} aria-label="Move the controls" title="Move the controls to another side">
          {SIDE_ICON[side]}
        </button>
        <button className={`icon-btn ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Menu">
          ☰
        </button>
      </header>
      {menu && (
        <div className="game-menu">
          <div className="button-row">
            <button className="button" onClick={() => run(store.request('game:phase', { phase: 'lobby' }))} title="Shows the join screen on the Main Screen again">
              Back to the lobby
            </button>
            <a className="button" href="/settings">Settings</a>
            <button className="button danger" onClick={() => store.leave()}>Leave game</button>
          </div>
        </div>
      )}
      <div className="game-body">
      <div className="game-board">
        {preview && <div className="preview-banner">Preview of {preview.place.name}: only you can see it</div>}
        <MapBoard
          state={mapState}
          camera={camera}
          onCameraChange={setCamera}
          canDrag={() => !preview}
          onMoveToken={(token, to) =>
              // the map needs the refusal too, to put the token back
              store.request('token:move', { tokenId: token.id, x: to.x, y: to.y }).then(
                () => setError(null),
                (e: Error) => {
                  setError(e.message);
                  throw e;
                },
              )
            }
          selectedTokenId={selectedId}
          onSelectToken={(t) => {
            setSelectedId(t?.id ?? null);
            if (t) setPanel('token');
          }}
          tableFrame={preview ? undefined : { onMove: (c) => run(store.request('view:set', c)) }}
          onTapEntrance={
            preview
              ? undefined
              : (e) => {
                  setEntranceId(e.id);
                  setPanel('world');
                }
          }
          selectedEntranceId={entranceId}
          onTapMap={aimState.aim ? aimState.tapMap : targeting.pending ? targeting.tap : undefined}
          movedFt={movedFt}
          currentTokenId={current?.id ?? null}
          showHp
          areaPreview={aimState.preview}
          localHighlight={preview ? null : highlight.local}
        />
      </div>
      <footer className="game-controls">
        <nav className="tab-bar">
          {PANELS.map((p) => (
            <button key={p.id} className={panel === p.id ? 'on' : ''} onClick={() => setPanel(p.id)} data-testid={`tab-${p.id}`}>
              {p.label}
              {p.id === 'combat' && state.combat ? <span className="tab-dot" /> : null}
            </button>
          ))}
        </nav>
        {error && (
          <p className="error" onClick={() => setError(null)}>
            {error}
          </p>
        )}

        {panel === 'token' &&
          (selected ? (
            <div className="stack-sm">
              <div className="selected-head">
                <span className="badge-dot big" style={{ background: selected.color }} />
                <div className="grow">
                  <strong>{selected.name}</strong>
                  <div className="hint">{selected.kind === 'player' ? (owner ? `played by ${owner.name}` : 'no player') : selected.stats?.monster ? `monster · AC ${selected.stats.ac}` : selected.kind}</div>
                </div>
                <button className="icon-btn" onClick={() => setSelectedId(null)} aria-label="Deselect">✕</button>
              </div>
              <h4 className="section-label">Health and conditions</h4>
              <TokenStatus store={store} state={state} token={selected} rules={rules} />
              <h4 className="section-label">Actions</h4>
              {targeting.pending ? (
                <TargetBar targeting={targeting} />
              ) : aimState.aim ? (
                <AimBar aimState={aimState} character={selectedCharacter} rules={rules} />
              ) : (
                <ActionPanel
                  store={store}
                  state={state}
                  token={selected}
                  character={selectedCharacter}
                  rules={rules}
                  aimState={aimState}
                  canRemoveArea={() => true}
                  dmTools
                  targeting={targeting}
                  highlight={highlight}
                />
              )}
              {selectedMonster && !targeting.pending && (
                <>
                  <button className="section-toggle" onClick={() => setShowStats(!showStats)} aria-expanded={showStats}>
                    Stat block {showStats ? '▾' : '▸'}
                  </button>
                  {showStats && <MonsterBlock monster={selectedMonster} token={selected} targeting={targeting} />}
                </>
              )}
              <h4 className="section-label">Token</h4>
              {selected.kind === 'player' && (
                <label className="inline-label">
                  Played by
                  <select
                    value={selected.ownerId && owner ? selected.ownerId : ''}
                    onChange={(e) => run(store.request('token:assign', { tokenId: selected.id, memberId: e.target.value || null }))}
                  >
                    <option value="">Nobody right now</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="button danger"
                onClick={() => {
                  if (!confirm(`Remove ${selected.name} from the map?`)) return;
                  run(store.request('token:remove', { tokenId: selected.id }));
                  setSelectedId(null);
                }}
              >
                Remove {selected.name} from the map
              </button>
            </div>
          ) : (
            <div className="empty-state">
              <strong>Nothing selected</strong>
              <p className="hint">Tap a token on the map to see its health, conditions and actions. Drag tokens to move them.</p>
            </div>
          ))}

        {panel === 'combat' && (
          <CombatPanel
            store={store}
            state={state}
            onSelect={(id) => {
              setSelectedId(id);
              setPanel('token');
            }}
          />
        )}

        {panel === 'add' && (
          <>
            <h4 className="section-label">A monster from the rules</h4>
            <MonsterPicker store={store} onAdded={(id) => setSelectedId(id)} />
            <h4 className="section-label">Your own token</h4>
            <AddToken store={store} onAdded={(id) => setSelectedId(id)} />
          </>
        )}

        {panel === 'world' && (
          <WorldPanel
            store={store}
            state={state}
            preview={preview}
            onPreview={showPreview}
            selectedEntranceId={entranceId}
            onSelectEntrance={setEntranceId}
            onFocus={(at) => setCamera((c) => ({ ...c, x: at.x, y: at.y }))}
          />
        )}

        {panel === 'party' && (
          <>
            <div className="segmented">
              <button className={partyTab === 'characters' ? 'on' : ''} onClick={() => setPartyTab('characters')}>Characters ({state.characters.length})</button>
              <button className={partyTab === 'players' ? 'on' : ''} onClick={() => setPartyTab('players')}>Players ({players.length})</button>
            </div>
            {partyTab === 'characters' && <CharacterList store={store} state={state} />}
          </>
        )}

        {panel === 'campaign' && (
          <>
            <div className="segmented">
              <button className={campaignTab === 'saves' ? 'on' : ''} onClick={() => setCampaignTab('saves')}>Saving</button>
              <button className={campaignTab === 'custom' ? 'on' : ''} onClick={() => setCampaignTab('custom')}>Custom content</button>
            </div>
            {campaignTab === 'saves' && <CampaignPanel store={store} state={state} />}
            {campaignTab === 'custom' && (rules ? <HomebrewPanel store={store} homebrew={state.homebrew} rules={rules} myId="" isDm /> : <p className="hint">Loading the rules…</p>)}
          </>
        )}

        {panel === 'table' && (
          <div className="stack-sm">
            <p className="hint">Drag the "Main Screen" frame's handle on your map to change what the table shows.</p>
            <CalibrationControls store={store} table={state.table} />
          </div>
        )}

        {panel === 'party' && partyTab === 'players' && (
          <ul className="list">
            {players.length === 0 && <li className="hint">No players yet.</li>}
            {players.map((p) => (
              <li key={p.id}>
                <span className="badge-dot" style={{ background: p.color }} />
                <span className="grow">
                  {p.name}
                  <span className="hint"> · Seat {seatNumber(p.seat) || '–'}{!p.connected && ' · away'}</span>
                </span>
                <button className="button small" onClick={() => kick(p)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </footer>
      <RollResult roll={targeting.result} onClose={targeting.clearResult} />
      </div>
    </div>
  );
}

function AddToken({ store, onAdded }: { store: GameStore; onAdded: (id: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TokenKind>('monster');
  const [color, setColor] = useState(TOKEN_SHADES[0]);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { tokenId } = await store.request('token:add', { name: name || (kind === 'npc' ? 'NPC' : 'Monster'), kind, color });
      setName('');
      setError(null);
      onAdded(tokenId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="stack-sm" onSubmit={add}>
      <div className="segmented">
        <button type="button" className={kind === 'monster' ? 'on' : ''} onClick={() => setKind('monster')}>Monster</button>
        <button type="button" className={kind === 'npc' ? 'on' : ''} onClick={() => setKind('npc')}>NPC</button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'npc' ? 'e.g. Torva the smith' : 'e.g. Goblin 1'} maxLength={24} aria-label="Token name" />
      <div className="swatches">
        {TOKEN_SHADES.map((c) => (
          <button
            type="button"
            key={c}
            className={`swatch ${c === color ? 'on' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-label={`Shade ${c}`}
          />
        ))}
      </div>
      <button className="button primary block">Add to the map</button>
      <p className="hint">New tokens appear in the middle of what the Main Screen shows.</p>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
