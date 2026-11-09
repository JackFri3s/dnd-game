import { useState } from 'react';
import type { Highlight, Member, RoomState, TokenKind } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { HexBoard, type Camera } from '../components/HexBoard.tsx';
import { CalibrationControls } from '../components/CalibrationControls.tsx';
import { seatNumber } from '../seats.ts';

const TOKEN_COLORS = ['#5b5b5b', '#8b2e1f', '#2f6b3a', '#6b4a8b', '#b07a1f', '#1f5f8b'];
const RANGES = [5, 30, 60, 120];
type Panel = 'token' | 'add' | 'screen' | 'players';

/** The DM's device during play: the whole map, every token, and the Main Screen controls. */
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

  const showHighlight = (h: Omit<Highlight, 'tokenId'> | null) =>
    selected && run(store.request('highlight:set', { highlight: h && { ...h, tokenId: selected.id } }));
  const active = selected && state.highlight?.tokenId === selected.id ? state.highlight : null;

  function kick(p: Member) {
    if (!confirm(`Remove ${p.name} from the game?`)) return;
    run(store.request('dm:kick', { memberId: p.id }));
  }

  return (
    <div className="game-layout" data-testid="dm-game">
      <header className="game-bar">
        <strong className="grow">📜 Dungeon Master · {state.code}</strong>
        <span className={`dot ${table?.connected ? 'on' : 'off'}`} title={`Main Screen ${table?.connected ? 'connected' : 'offline'}`} />
        <button className="small-button" onClick={() => setCamera({ ...camera, ...state.view })}>📺 Find Main Screen</button>
        <button className="small-button" onClick={() => setMenu(!menu)} aria-expanded={menu}>☰</button>
      </header>
      {menu && (
        <div className="game-menu">
          <button className="link-button" onClick={() => run(store.request('game:phase', { phase: 'lobby' }))}>
            Back to the lobby (shows the join screen on the Main Screen)
          </button>
          <button className="link-button" onClick={() => store.leave()}>Leave game</button>
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
        />
      </div>
      <footer className="game-controls">
        <nav className="tabs">
          {(['token', 'add', 'screen', 'players'] as Panel[]).map((p) => (
            <button key={p} className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
              {{ token: 'Selected', add: 'Add token', screen: 'Main Screen', players: `Players (${players.length})` }[p]}
            </button>
          ))}
        </nav>
        {error && <p className="error">{error}</p>}

        {panel === 'token' &&
          (selected ? (
            <div>
              <p>
                <span className="badge-dot" style={{ background: selected.color }} /> <strong>{selected.name}</strong>{' '}
                <span className="hint">({selected.kind})</span>
              </p>
              <div className="chip-row">
                <button className={`chip ${active?.kind === 'move' ? 'on' : ''}`} onClick={() => showHighlight({ kind: 'move', feet: selected.speedFt })}>
                  🥾 Movement {selected.speedFt} ft
                </button>
                {RANGES.map((ft) => (
                  <button
                    key={ft}
                    className={`chip ${active?.kind === 'range' && active.feet === ft ? 'on' : ''}`}
                    onClick={() => showHighlight({ kind: 'range', feet: ft })}
                  >
                    🎯 {ft === 5 ? 'Reach 5 ft' : `${ft} ft`}
                  </button>
                ))}
                {state.highlight && (
                  <button className="chip" onClick={() => run(store.request('highlight:set', { highlight: null }))}>✕ Hide</button>
                )}
              </div>
              {selected.kind !== 'player' && (
                <button
                  className="link-button"
                  onClick={() => {
                    run(store.request('token:remove', { tokenId: selected.id }));
                    setSelectedId(null);
                  }}
                >
                  Remove {selected.name}
                </button>
              )}
            </div>
          ) : (
            <p className="hint">Tap a token on the map to select it. Drag tokens to move them.</p>
          ))}

        {panel === 'add' && <AddToken store={store} onAdded={(id) => setSelectedId(id)} />}

        {panel === 'screen' && (
          <div>
            <p className="hint">Drag the "Main Screen" handle on the map to change what the table shows.</p>
            <CalibrationControls store={store} table={state.table} />
          </div>
        )}

        {panel === 'players' && (
          <ul className="member-list">
            {players.length === 0 && <li className="hint">No players yet.</li>}
            {players.map((p) => (
              <li key={p.id}>
                <span className="badge-dot" style={{ background: p.color }} />
                <span className="grow">
                  {p.name}
                  <span className="hint"> · Seat {seatNumber(p.seat) || '–'}{!p.connected && ' · away'}</span>
                </span>
                <button className="small-button" onClick={() => kick(p)}>Remove</button>
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
  const [color, setColor] = useState(TOKEN_COLORS[1]);
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
    <form className="add-token" onSubmit={add}>
      <div className="role-toggle small">
        <button type="button" className={kind === 'monster' ? 'on' : ''} onClick={() => setKind('monster')}>👹 Monster</button>
        <button type="button" className={kind === 'npc' ? 'on' : ''} onClick={() => setKind('npc')}>🧑 NPC</button>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'npc' ? 'e.g. Torva the smith' : 'e.g. Goblin 1'} maxLength={24} aria-label="Token name" />
      <div className="swatches">
        {TOKEN_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            className={`swatch ${c === color ? 'on' : ''}`}
            style={{ background: c }}
            onClick={() => setColor(c)}
            aria-label={`Colour ${c}`}
          />
        ))}
      </div>
      <button className="primary">Add to the map</button>
      <p className="hint">It appears in the middle of what the Main Screen shows.</p>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
