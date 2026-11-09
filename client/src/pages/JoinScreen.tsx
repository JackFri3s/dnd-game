import { useEffect, useState } from 'react';
import { SEATS, type Member, type RoomState, type SeatId } from '../../../shared/protocol.ts';
import { clientId, loadSession, peekRoom, read, write } from '../socket.ts';
import { GameStore, useGame } from '../game.ts';
import { seatNumber } from '../seats.ts';
import { PlayerGame } from './PlayerGame.tsx';
import { DmGame } from './DmGame.tsx';
import { CalibrationControls } from '../components/CalibrationControls.tsx';

type Role = 'player' | 'dm';
const stores = { player: new GameStore('player'), dm: new GameStore('dm') };

/** The page for players and the DM: join a game, then the lobby, then the game itself. */
export function JoinScreen({ initialRole }: { initialRole: Role }) {
  // If this device was already in a game, go back to it in the same role.
  const [role, setRole] = useState<Role>(() =>
    loadSession('dm') ? 'dm' : loadSession('player') ? 'player' : initialRole,
  );
  const store = stores[role];
  const game = useGame(store);

  useEffect(() => {
    store.resume();
  }, [store]);

  /** Leave the game and come back to the join form in the other role. */
  async function switchRole(to: Role) {
    await store.leave();
    setRole(to);
  }

  const inGame = game.me && game.state;
  const playing = game.state?.phase === 'playing';
  return (
    <main className={`page join ${inGame && playing ? 'in-play' : ''}`}>
      {!(inGame && playing) && (
        <header className="join-header">
          <a href="/" className="title small">dnd</a>
          {game.code && (
            <span className={`dot ${game.status === 'open' ? 'on' : 'off'}`} title={game.status === 'open' ? 'Connected' : 'Offline'} />
          )}
        </header>
      )}
      {inGame && game.status !== 'open' && <p className="status warn">Connection lost, reconnecting…</p>}
      {game.notice && <p className="status">{game.notice}</p>}
      {game.ended === 'replaced' ? (
        <button className="primary" onClick={() => store.open(game.code!)}>Use this device instead</button>
      ) : inGame ? (
        role === 'player' ? (
          playing ? (
            <PlayerGame store={store} me={game.me!} state={game.state!} onSwitchRole={() => switchRole('dm')} />
          ) : (
            <PlayerLobby store={store} me={game.me!} state={game.state!} onSwitchRole={() => switchRole('dm')} />
          )
        ) : playing ? (
          <DmGame store={store} state={game.state!} />
        ) : (
          <DmLobby store={store} me={game.me!} state={game.state!} onSwitchRole={() => switchRole('player')} />
        )
      ) : (
        <JoinForm store={store} role={role} onRoleChange={setRole} />
      )}
    </main>
  );
}

function JoinForm({ store, role, onRoleChange }: { store: GameStore; role: Role; onRoleChange: (r: Role) => void }) {
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? '',
  );
  const [name, setName] = useState(() => read('dnd.name') ?? '');
  const [seat, setSeat] = useState<SeatId | null>(null);
  const [preview, setPreview] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Look up the game as soon as a full code is typed, to show free seats.
  useEffect(() => {
    setPreview(null);
    if (code.length !== 4) return;
    let cancelled = false;
    peekRoom(code).then(
      (s) => {
        if (cancelled) return;
        setPreview(s);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  const dm = preview?.members.find((m) => m.role === 'dm');
  const dmTaken = !!dm && dm.id !== clientId;
  const takenSeats = new Set(
    preview?.members.filter((m) => m.role === 'player' && m.id !== clientId).map((m) => m.seat) ?? [],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await store.join(code, { role, name, seat: role === 'player' ? seat : null });
      write('dnd.name', name.trim());
    } catch (err) {
      setError((err as Error).message);
      if (code.length === 4) peekRoom(code).then(setPreview, () => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Join the game</h2>
      <div className="role-toggle" role="radiogroup" aria-label="Join as">
        <button type="button" role="radio" aria-checked={role === 'player'} className={role === 'player' ? 'on' : ''} onClick={() => onRoleChange('player')}>
          🛡️ Player
        </button>
        <button type="button" role="radio" aria-checked={role === 'dm'} className={role === 'dm' ? 'on' : ''} onClick={() => onRoleChange('dm')}>
          📜 Dungeon Master
        </button>
      </div>
      <label>
        Game code
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
          placeholder="ABCD"
          autoCapitalize="characters"
          autoComplete="off"
          inputMode="text"
          required
        />
      </label>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
      </label>

      {role === 'dm' && dmTaken && <p className="error">{dm!.name} is already the Dungeon Master of this game.</p>}

      {role === 'player' && preview && (
        <fieldset>
          <legend>Where are you sitting?</legend>
          <p className="hint">Match the seat numbers shown on the Main Screen.</p>
          <SeatPicker value={seat} taken={takenSeats} onChange={setSeat} />
          <p className="hint">{seat ? `Seat ${seatNumber(seat)}` : 'No seat chosen: the first free one will be used.'}</p>
        </fieldset>
      )}

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || code.length !== 4 || !name.trim() || (role === 'dm' && dmTaken)}>
        {busy ? 'Joining…' : role === 'dm' ? 'Join as Dungeon Master' : 'Join as player'}
      </button>
    </form>
  );
}

function PlayerLobby({
  store,
  me,
  state,
  onSwitchRole,
}: {
  store: GameStore;
  me: Member;
  state: RoomState;
  onSwitchRole: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const taken = new Set(state.members.filter((m) => m.role === 'player' && m.id !== me.id).map((m) => m.seat));
  const dm = state.members.find((m) => m.role === 'dm');
  const others = state.members.filter((m) => m.role === 'player' && m.id !== me.id);

  function changeSeat(seat: SeatId) {
    store.request('seat:change', { seat }).then(() => setError(null), (e: Error) => setError(e.message));
  }

  return (
    <section className="card" data-testid="player-lobby">
      <p className="label">You're in game <strong>{state.code}</strong></p>
      <h2 className="me-name">
        <span className="badge-dot big" style={{ background: me.color }} />
        {me.name}
      </h2>
      <p>Waiting for the Dungeon Master to start the campaign.</p>
      <fieldset>
        <legend>Your seat</legend>
        <SeatPicker value={me.seat} taken={taken} onChange={changeSeat} />
      </fieldset>
      {error && <p className="error">{error}</p>}
      <h3>At the table</h3>
      <MemberList dm={dm} players={others} />
      <div className="row-buttons">
        <button className="link-button" onClick={onSwitchRole} disabled={!!dm}>
          {dm ? 'There is already a Dungeon Master' : 'Be the Dungeon Master instead'}
        </button>
        <button className="link-button" onClick={() => store.leave()}>Leave game</button>
      </div>
    </section>
  );
}

function DmLobby({
  store,
  me,
  state,
  onSwitchRole,
}: {
  store: GameStore;
  me: Member;
  state: RoomState;
  onSwitchRole: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const players = state.members.filter((m) => m.role === 'player');
  const table = state.members.find((m) => m.role === 'table');
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  function kick(p: Member) {
    if (!confirm(`Remove ${p.name} from the game?`)) return;
    run(store.request('dm:kick', { memberId: p.id }));
  }

  return (
    <section className="card" data-testid="dm-lobby">
      <p className="label">Dungeon Master of game <strong>{state.code}</strong></p>
      <h2 className="me-name">📜 {me.name}</h2>
      <p className="status-line">
        <span className={`dot ${table?.connected ? 'on' : 'off'}`} /> Main Screen {table?.connected ? 'connected' : 'offline'}
      </p>

      <button className="primary" onClick={() => run(store.request('game:phase', { phase: 'playing' }))} data-testid="start-campaign">
        ▶ Start the campaign
      </button>
      <p className="hint">Players can still join after the start: the join code stays visible on the Main Screen.</p>

      <h3>Main Screen size</h3>
      <CalibrationControls store={store} table={state.table} />

      <h3>Players ({players.length})</h3>
      {players.length === 0 && <p className="hint">Players join by scanning the QR code on the Main Screen.</p>}
      <ul className="member-list">
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
      {error && <p className="error">{error}</p>}
      <div className="row-buttons">
        <button className="link-button" onClick={onSwitchRole}>Join as a player instead</button>
        <button className="link-button" onClick={() => store.leave()}>Leave game</button>
      </div>
    </section>
  );
}

export function MemberList({ dm, players }: { dm: Member | undefined; players: Member[] }) {
  return (
    <ul className="member-list">
      <li>
        📜 {dm ? <>{dm.name} <em>(Dungeon Master)</em>{!dm.connected && ' – away'}</> : <em>No Dungeon Master yet</em>}
      </li>
      {players.map((p) => (
        <li key={p.id}>
          <span className="badge-dot" style={{ background: p.color }} /> {p.name}
          {!p.connected && <em> – away</em>}
        </li>
      ))}
    </ul>
  );
}

/** A small drawing of the table with the 8 seats around the Main Screen. */
function SeatPicker({
  value,
  taken,
  onChange,
}: {
  value: SeatId | null;
  taken: Set<SeatId | null>;
  onChange: (s: SeatId) => void;
}) {
  return (
    <div className="seat-picker">
      <div className="seat-picker-table">Main Screen</div>
      {SEATS.map((s, i) => (
        <button
          type="button"
          key={s.id}
          className={`seat-pick seat-${s.id} ${value === s.id ? 'selected' : ''}`}
          disabled={taken.has(s.id)}
          onClick={() => onChange(s.id)}
          aria-pressed={value === s.id}
          aria-label={`Seat ${i + 1}${taken.has(s.id) ? ' (taken)' : ''}`}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}
