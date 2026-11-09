import { useEffect, useState } from 'react';
import { SEATS, type Member, type RoomState, type SeatId } from '../../../shared/protocol.ts';
import { clientId, loadSession, peekRoom, read, write } from '../socket.ts';
import { GameStore, useGame } from '../game.ts';
import { seatNumber } from '../seats.ts';
import { PlayerGame } from './PlayerGame.tsx';
import { DmGame } from './DmGame.tsx';
import { CalibrationControls } from '../components/CalibrationControls.tsx';
import { CampaignPanel } from '../components/CampaignPanel.tsx';
import { CharacterScreen } from '../characters/CharacterScreen.tsx';
import { CharacterList } from '../characters/CharacterList.tsx';
import { HomebrewPanel } from '../characters/HomebrewPanel.tsx';
import { useRules } from '../rules/index.ts';

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
        <header className="page-header">
          <a href="/" className="back">← dnd</a>
          {game.code && (
            <span className={`dot ${game.status === 'open' ? 'on' : 'off'}`} title={game.status === 'open' ? 'Connected' : 'Offline'} />
          )}
        </header>
      )}
      {inGame && game.status !== 'open' && <p className="status warn">Connection lost, reconnecting…</p>}
      {game.notice && (
        <p className="status" onClick={() => store.dismissNotice()}>
          {game.notice} <span className="hint">(tap to close)</span>
        </p>
      )}
      {game.ended === 'replaced' ? (
        <button className="button primary block" onClick={() => store.open(game.code!)}>Use this device instead</button>
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
      <div className="segmented" role="radiogroup" aria-label="Join as">
        <button type="button" role="radio" aria-checked={role === 'player'} className={role === 'player' ? 'on' : ''} onClick={() => onRoleChange('player')}>
          Player
        </button>
        <button type="button" role="radio" aria-checked={role === 'dm'} className={role === 'dm' ? 'on' : ''} onClick={() => onRoleChange('dm')}>
          Dungeon Master
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
      <button className="button primary block" disabled={busy || code.length !== 4 || !name.trim() || (role === 'dm' && dmTaken)}>
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
  const [showCharacter, setShowCharacter] = useState(false);
  const myCharacter = state.characters.find((c) => c.ownerId === me.id) ?? null;
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
      <p>
        Waiting for the Dungeon Master to start
        {state.campaign ? <> <strong>{state.campaign.name}</strong></> : ' the campaign'}.
      </p>
      <div className="character-card">
        <div className="label">Your character</div>
        {myCharacter ? (
          <div className="row">
            <div className="grow">
              <strong data-testid="my-character">{myCharacter.name}</strong>
              <div className="hint">{myCharacter.summary.classLine}</div>
            </div>
            <button className="button small" onClick={() => setShowCharacter(true)}>Open</button>
          </div>
        ) : state.campaign ? (
          <button className="button primary block" onClick={() => setShowCharacter(true)} data-testid="create-character">
            Create your character
          </button>
        ) : (
          <p className="hint">You can create your character once the Dungeon Master has chosen the campaign.</p>
        )}
      </div>
      {showCharacter && <CharacterScreen store={store} character={myCharacter} editable onClose={() => setShowCharacter(false)} />}
      <fieldset>
        <legend>Your seat</legend>
        <SeatPicker value={me.seat} taken={taken} onChange={changeSeat} />
      </fieldset>
      {error && <p className="error">{error}</p>}
      <h3>At the table</h3>
      <MemberList dm={dm} players={others} />
      <div className="row-buttons">
        {!dm && (
          <button className="text-button" onClick={onSwitchRole}>
            Be the Dungeon Master instead
          </button>
        )}
        <button className="text-button" onClick={() => store.leave()}>Leave game</button>
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
    <section className="stack" data-testid="dm-lobby">
      <div className="card">
        <div className="label">Dungeon Master · game {state.code}</div>
        <h2 className="me-name">{me.name}</h2>
        <p className="status-line">
          <span className={`dot ${table?.connected ? 'on' : 'off'}`} /> Main Screen {table?.connected ? 'connected' : 'offline'}
        </p>
      </div>

      <div className="card">
        <h3 className="step-title"><span className="step-num">1</span> Campaign</h3>
        <CampaignPanel store={store} state={state} />
      </div>

      {state.campaign && (
        <div className="card">
          <h3>Characters</h3>
          <CharacterList store={store} state={state} />
        </div>
      )}

      {state.campaign && <CustomContentCard store={store} state={state} />}

      <div className="card">
        <h3 className="step-title"><span className="step-num">2</span> Main Screen size</h3>
        <CalibrationControls store={store} table={state.table} />
      </div>

      <div className="card">
        <h3 className="step-title"><span className="step-num">3</span> Players ({players.length})</h3>
        {players.length === 0 && <p className="hint">Players join by scanning the QR code on the Main Screen.</p>}
        <ul className="list">
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
      </div>
      <div className="card start-card">
        <button
          className="button primary block big"
          disabled={!state.campaign}
          onClick={() => run(store.request('game:phase', { phase: 'playing' }))}
          data-testid="start-campaign"
        >
          {state.campaign ? `▶ Start ${state.campaign.name}` : 'Choose a campaign first (step 1)'}
        </button>
        <p className="hint">Players can still join after the start: the join code stays visible on the Main Screen.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row-buttons">
        <button className="text-button" onClick={onSwitchRole}>Join as a player instead</button>
        <button className="text-button" onClick={() => store.leave()}>Leave game</button>
        <a className="text-button" href="/settings">Settings</a>
      </div>
    </section>
  );
}

export function MemberList({ dm, players }: { dm: Member | undefined; players: Member[] }) {
  return (
    <ul className="list">
      <li>
        <span className="badge-dot dm" />
        {dm ? <>{dm.name} <span className="hint">Dungeon Master{!dm.connected && ' · away'}</span></> : <span className="hint">No Dungeon Master yet</span>}
      </li>
      {players.map((p) => (
        <li key={p.id}>
          <span className="badge-dot" style={{ background: p.color }} /> {p.name}
          {!p.connected && <span className="hint"> · away</span>}
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

/** The DM's custom content, folded away until opened (the rules load when it opens). */
function CustomContentCard({ store, state }: { store: GameStore; state: RoomState }) {
  const [open, setOpen] = useState(false);
  const count = state.homebrew.species.length + state.homebrew.classes.length + state.homebrew.spells.length + state.homebrew.items.length;
  return (
    <div className="card">
      <h3>Custom content ({count})</h3>
      {open ? <CustomContentInner store={store} state={state} /> : <button className="button block" onClick={() => setOpen(true)}>Species, classes, spells and items</button>}
    </div>
  );
}

function CustomContentInner({ store, state }: { store: GameStore; state: RoomState }) {
  const rules = useRules(state.homebrew);
  if (!rules) return <p className="hint">Loading the rules…</p>;
  return <HomebrewPanel store={store} homebrew={state.homebrew} rules={rules} myId="" isDm />;
}
