import { useState } from 'react';
import type { Member, RoomState, TokenKind } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { HexBoard, type Camera } from '../components/HexBoard.tsx';
import { CalibrationControls } from '../components/CalibrationControls.tsx';
import { CampaignPanel } from '../components/CampaignPanel.tsx';
import { ActionPanel, AimBar, useAim } from '../components/Actions.tsx';
import { useRules } from '../rules/index.ts';
import { CharacterList } from '../characters/CharacterList.tsx';
import { seatNumber } from '../seats.ts';

const TOKEN_SHADES = ['#1a1a1a', '#4d4d4d', '#808080', '#b3b3b3'];
type Panel = 'token' | 'add' | 'characters' | 'campaign' | 'screen' | 'players';
const PANELS: { id: Panel; label: string }[] = [
  { id: 'token', label: 'Selected' },
  { id: 'add', label: 'Add' },
  { id: 'characters', label: 'Characters' },
  { id: 'campaign', label: 'Campaign' },
  { id: 'screen', label: 'Main Screen' },
  { id: 'players', label: 'Players' },
];

/** The DM's device during play: the whole map, every token, and the controls. */
export function DmGame({ store, state }: { store: GameStore; state: RoomState }) {
  const [camera, setCamera] = useState<Camera>({ ...state.view, scale: 40 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('add');
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const selected = state.tokens.find((t) => t.id === selectedId) ?? null;
  const players = state.members.filter((m) => m.role === 'player');
  const table = state.members.find((m) => m.role === 'table');
  const owner = selected?.ownerId ? state.members.find((m) => m.id === selected.ownerId) : null;
  const selectedCharacter = selected?.characterId ? (state.characters.find((c) => c.id === selected.characterId) ?? null) : null;
  const rules = useRules();
  const aimState = useAim(store, state);

  function kick(p: Member) {
    if (!confirm(`Remove ${p.name} from the game? Their token stays on the map.`)) return;
    run(store.request('dm:kick', { memberId: p.id }));
  }

  return (
    <div className="game-layout" data-testid="dm-game">
      <header className="game-bar">
        <strong className="grow">{state.campaign?.name ?? 'Dungeon Master'}</strong>
        <span className="hint">{state.code}</span>
        <span className={`dot ${table?.connected ? 'on' : 'off'}`} title={`Main Screen ${table?.connected ? 'connected' : 'offline'}`} />
        <button className="button small" onClick={() => setCamera({ ...camera, ...state.view })}>Find Main Screen</button>
        <button className="button small" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Menu">☰</button>
      </header>
      {menu && (
        <div className="game-menu">
          <button className="text-button" onClick={() => run(store.request('game:phase', { phase: 'lobby' }))}>
            Back to the lobby (shows the join screen on the Main Screen)
          </button>
          <a className="text-button" href="/settings">Settings</a>
          <button className="text-button" onClick={() => store.leave()}>Leave game</button>
        </div>
      )}
      <div className="game-board">
        <HexBoard
          state={state}
          camera={camera}
          onCameraChange={setCamera}
          canDrag={() => true}
          onMoveToken={(token, hex) => run(store.request('token:move', { tokenId: token.id, ...hex }))}
          selectedTokenId={selectedId}
          onSelectToken={(t) => {
            setSelectedId(t?.id ?? null);
            if (t) setPanel('token');
          }}
          tableFrame={{ onMove: (c) => run(store.request('view:set', c)) }}
          onTapHex={aimState.aim ? aimState.tapHex : undefined}
          areaPreview={aimState.preview}
        />
      </div>
      <footer className="game-controls">
        <nav className="tabs">
          {PANELS.map((p) => (
            <button key={p.id} className={panel === p.id ? 'on' : ''} onClick={() => setPanel(p.id)}>
              {p.id === 'players' ? `${p.label} (${players.length})` : p.label}
            </button>
          ))}
        </nav>
        {error && <p className="error">{error}</p>}

        {panel === 'token' &&
          (selected ? (
            <div className="stack-sm">
              <p className="row">
                <span className="badge-dot" style={{ background: selected.color }} />
                <strong>{selected.name}</strong>
                <span className="hint">{selected.kind === 'player' ? (owner ? `played by ${owner.name}` : 'no player') : selected.kind}</span>
              </p>
              {aimState.aim ? (
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
                />
              )}
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
                className="text-button"
                onClick={() => {
                  if (!confirm(`Remove ${selected.name} from the map?`)) return;
                  run(store.request('token:remove', { tokenId: selected.id }));
                  setSelectedId(null);
                }}
              >
                Remove {selected.name}
              </button>
            </div>
          ) : (
            <p className="hint">Tap a token on the map to select it. Drag tokens to move them.</p>
          ))}

        {panel === 'add' && <AddToken store={store} onAdded={(id) => setSelectedId(id)} />}

        {panel === 'characters' && <CharacterList store={store} state={state} />}

        {panel === 'campaign' && <CampaignPanel store={store} state={state} />}

        {panel === 'screen' && (
          <div>
            <p className="hint">Drag the "Main Screen" handle on the map to change what the table shows.</p>
            <CalibrationControls store={store} table={state.table} />
          </div>
        )}

        {panel === 'players' && (
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
      <p className="hint">It appears in the middle of what the Main Screen shows.</p>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
