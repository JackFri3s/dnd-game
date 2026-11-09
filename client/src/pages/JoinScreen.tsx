import { useEffect, useState } from 'react';
import { SEATS, type Member, type RoomState, type SeatId } from '../../../shared/protocol.ts';
import { clientId, peekRoom, read, write } from '../socket.ts';
import { GameStore, useGame } from '../game.ts';

type Role = 'player' | 'dm';
const stores = { player: new GameStore('player'), dm: new GameStore('dm') };

export function JoinScreen({ role }: { role: Role }) {
  const store = stores[role];
  const game = useGame(store);

  // Come back into the game automatically after a reload.
  useEffect(() => {
    store.resume();
  }, [store]);

  const inGame = game.me && game.state;
  return (
    <main className="page join">
      <header className="join-header">
        <a href="/" className="title small">dnd</a>
        {game.code && (
          <span className={`dot ${game.status === 'open' ? 'on' : 'off'}`} title={game.status === 'open' ? 'Connected' : 'Offline'} />
        )}
      </header>
      {inGame && game.status !== 'open' && <p className="status warn">Connection lost, reconnecting…</p>}
      {game.notice && <p className="status">{game.notice}</p>}
      {game.ended === 'replaced' ? (
        <button className="primary" onClick={() => store.open(game.code!)}>Use this device instead</button>
      ) : inGame ? (
        role === 'player' ? (
          <PlayerLobby store={store} me={game.me!} state={game.state!} />
        ) : (
          <DmLobby store={store} me={game.me!} state={game.state!} />
        )
      ) : (
        <JoinForm store={store} role={role} />
      )}
    </main>
  );
}

function JoinForm({ store, role }: { store: GameStore; role: Role }) {
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
  const takenSeats = new Set(
    preview?.members.filter((m) => m.role === 'player' && m.id !== clientId).map((m) => m.seat) ?? [],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await store.join(code, { role, name, seat });
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
      <h2>{role === 'dm' ? 'Join as Dungeon Master' : 'Join the game'}</h2>
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
        {role === 'dm' ? 'Your name' : 'Your name (you can pick a character later)'}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} required />
      </label>

      {role === 'dm' && dm && dm.id !== clientId && (
        <p className="error">{dm.name} is already the Dungeon Master of this game.</p>
      )}

      {role === 'player' && preview && (
        <fieldset>
          <legend>Where are you sitting?</legend>
          <p className="hint">Match the seat numbers shown on the Main Screen.</p>
          <SeatPicker value={seat} taken={takenSeats} onChange={setSeat} />
          <p className="hint">{seat ? `Seat ${SEATS.findIndex((s) => s.id === seat) + 1}` : 'No seat chosen: the first free one will be used.'}</p>
        </fieldset>
      )}

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || code.length !== 4 || !name.trim()}>
        {busy ? 'Joining…' : 'Join'}
      </button>
    </form>
  );
}

function PlayerLobby({ store, me, state }: { store: GameStore; me: Member; state: RoomState }) {
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
      <p>Waiting for the Dungeon Master to start the adventure.</p>
      <fieldset>
        <legend>Your seat</legend>
        <SeatPicker value={me.seat} taken={taken} onChange={changeSeat} />
      </fieldset>
      {error && <p className="error">{error}</p>}
      <h3>At the table</h3>
      <ul className="member-list">
        <li>
          📜 {dm ? <>{dm.name} <em>(Dungeon Master)</em>{!dm.connected && ' – away'}</> : <em>No Dungeon Master yet</em>}
        </li>
        {others.map((p) => (
          <li key={p.id}>
            <span className="badge-dot" style={{ background: p.color }} /> {p.name}
            {!p.connected && <em> – away</em>}
          </li>
        ))}
      </ul>
      <button className="link-button" onClick={() => store.leave()}>Leave game</button>
    </section>
  );
}

function DmLobby({ store, me, state }: { store: GameStore; me: Member; state: RoomState }) {
  const [error, setError] = useState<string | null>(null);
  const players = state.members.filter((m) => m.role === 'player');
  const table = state.members.find((m) => m.role === 'table');

  function kick(p: Member) {
    if (!confirm(`Remove ${p.name} from the game?`)) return;
    store.request('dm:kick', { memberId: p.id }).then(() => setError(null), (e: Error) => setError(e.message));
  }

  return (
    <section className="card" data-testid="dm-lobby">
      <p className="label">Dungeon Master of game <strong>{state.code}</strong></p>
      <h2 className="me-name">📜 {me.name}</h2>
      <p className="status-line">
        <span className={`dot ${table?.connected ? 'on' : 'off'}`} /> Main Screen {table?.connected ? 'connected' : 'offline'}
      </p>
      <h3>Players ({players.length})</h3>
      {players.length === 0 && <p className="hint">Players join by scanning the QR code on the Main Screen.</p>}
      <ul className="member-list">
        {players.map((p) => (
          <li key={p.id}>
            <span className="badge-dot" style={{ background: p.color }} />
            <span className="grow">
              {p.name}
              <span className="hint"> · Seat {SEATS.findIndex((s) => s.id === p.seat) + 1 || '–'}{!p.connected && ' · away'}</span>
            </span>
            <button className="small-button" onClick={() => kick(p)}>Remove</button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <p className="hint">Map, characters and combat tools arrive in the next steps.</p>
      <button className="link-button" onClick={() => store.leave()}>Leave game</button>
    </section>
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
