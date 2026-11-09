import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { SEATS, type Member, type RoomState } from '../../../shared/protocol.ts';
import { GameStore, useGame } from '../game.ts';
import { SIDE_ROTATION } from '../seats.ts';
import { MapBoard } from '../components/MapBoard.tsx';
import { read, write } from '../socket.ts';
import { useSettings } from '../settings.ts';
import { CalibrationCard } from '../components/CalibrationCard.tsx';
import { RollToasts } from '../components/RollToasts.tsx';

const store = new GameStore('table');
let starting = false; // guards against starting two games at once

function startNewGame(setError: (e: string | null) => void) {
  if (starting) return;
  starting = true;
  store
    .create()
    .then(() => setError(null), (e: Error) => setError(e.message))
    .finally(() => {
      starting = false;
    });
}

export function TableScreen() {
  const game = useGame(store);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  // Open last time's game on this screen, or start a new one.
  useEffect(() => {
    if (!store.getSnapshot().code && !store.resume()) startNewGame(setError);
  }, []);

  // The saved game is gone (e.g. deleted after a long time): start a fresh one.
  useEffect(() => {
    if (game.ended === 'no-room') startNewGame(setError);
  }, [game.ended]);

  const code = game.code;
  const joinUrl = code ? `${window.location.origin}/join?code=${code}` : '';
  useEffect(() => {
    if (!joinUrl) return;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinUrl]);

  // Tell the game how big this screen is, so the DM can see what it shows.
  const joined = !!game.me && game.status === 'open';
  useEffect(() => {
    if (!joined) return;
    let timer: number | undefined;
    const report = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        store.request('table:viewport', { w: window.innerWidth, h: window.innerHeight }).catch(() => {});
      }, 300);
    };
    report();
    window.addEventListener('resize', report);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', report);
    };
  }, [joined]);

  // Calibration belongs to this screen: remember it here, and reuse it in every new game.
  const table = game.state?.table;
  useEffect(() => {
    if (!joined || !table) return;
    if (table.calibrated && !table.calibrating) {
      write('dnd.calibration', JSON.stringify({ pxPerMm: table.pxPerMm, hexMm: table.hexMm }));
    } else if (!table.calibrated && !table.calibrating) {
      try {
        const saved = JSON.parse(read('dnd.calibration') ?? 'null');
        if (saved) store.request('table:calibrate', { ...saved, done: true }).catch(() => {});
      } catch {
        // ignore a broken saved value
      }
    }
  }, [joined, table?.calibrated, table?.calibrating, table?.pxPerMm, table?.hexMm]); // eslint-disable-line react-hooks/exhaustive-deps

  // A keyboard on the Main Screen can also fine-tune the calibration (+ / - keys).
  const calibrating = game.state?.table.calibrating;
  useEffect(() => {
    if (!calibrating) return;
    const onKey = (e: KeyboardEvent) => {
      const t = store.getSnapshot().state?.table;
      if (!t) return;
      const step = e.shiftKey ? 0.01 : 0.002;
      if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') store.request('table:calibrate', { pxPerMm: t.pxPerMm * (1 + step) });
      if (e.key === '-' || e.key === 'ArrowDown') store.request('table:calibrate', { pxPerMm: t.pxPerMm * (1 - step) });
      if (e.key === 'Enter') store.request('table:calibrate', { done: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [calibrating]);

  if (game.state?.table.calibrating) {
    return <CalibrationCard table={game.state.table} />;
  }

  if (game.state?.phase === 'playing' && code) {
    return <TableBoard state={game.state} code={code} connected={game.status === 'open'} />;
  }

  const members = game.state?.members ?? [];
  const dm = members.find((m) => m.role === 'dm');
  const players = members.filter((m) => m.role === 'player');

  function newGame() {
    if (!confirm('Start a new game? Everyone will need to join again.')) return;
    startNewGame(setError);
  }

  if (game.ended === 'replaced') {
    return (
      <main className="table-screen">
        <section className="table-center">
          <h1 className="title small">dnd</h1>
          <p>{game.notice}</p>
          <button className="button primary" onClick={() => store.open(code!)}>Use this screen instead</button>
        </section>
      </main>
    );
  }

  return (
    <main className="table-screen">
      {SEATS.map((seat, i) => {
        const player = players.find((p) => p.seat === seat.id);
        return (
          <div key={seat.id} className={`seat seat-${seat.id}`}>
            <div className="seat-inner" style={{ transform: `rotate(${SIDE_ROTATION[seat.side]}deg)` }}>
              {player ? <PlayerBadge player={player} /> : <span className="seat-free">Seat {i + 1}</span>}
            </div>
          </div>
        );
      })}

      {game.state && <RollToasts state={game.state} />}
      <section className="table-center">
        <h1 className="title small">dnd</h1>
        {error && <p className="error">{error}</p>}
        {code && game.status !== 'open' && <p className="status warn">Connecting to the game…</p>}
        {code && (
          <>
            <p className="label">Scan to join, or go to</p>
            <p className="join-url">{window.location.host}/join</p>
            {qr && <img className="qr" src={qr} alt={`QR code to join game ${code}`} />}
            <p className="label">Game code</p>
            <p className="room-code" data-testid="room-code">{code}</p>
            <p className="dm-status">
              {dm ? (
                <>
                  <span className={`dot ${dm.connected ? 'on' : 'off'}`} /> Dungeon Master: <strong>{dm.name}</strong>
                </>
              ) : (
                <>Waiting for the Dungeon Master to join at <strong>{window.location.host}/dm</strong></>
              )}
            </p>
            <p className="player-count">
              {players.length} {players.length === 1 ? 'player' : 'players'} at the table
            </p>
            {state_campaign(game.state)}
            {dm && <p className="player-count">The Dungeon Master starts the game from their device.</p>}
            <button className="text-button" onClick={newGame}>Start a new game</button>
          </>
        )}
      </section>
    </main>
  );
}

function PlayerBadge({ player }: { player: Member }) {
  return (
    <span
      className={`player-badge ${player.connected ? '' : 'away'}`}
      style={{ borderColor: player.color }}
      data-testid={`seat-player-${player.name}`}
    >
      <span className="badge-dot" style={{ background: player.color }} />
      {player.name}
      {!player.connected && <em> (away)</em>}
    </span>
  );
}

/** The Main Screen during play: the map at true size. */
function TableBoard({ state, code, connected }: { state: RoomState; code: string; connected: boolean }) {
  const scale = state.table.pxPerMm * state.table.hexMm;
  return (
    <main className="table-screen playing">
      <MapBoard
        state={state}
        camera={{ x: state.view.x, y: state.view.y, scale }}
        canDrag={() => true}
        onMoveToken={(token, to) => store.request('token:move', { tokenId: token.id, x: to.x, y: to.y })}
        faceSeats
      />
      <RollToasts state={state} />
      <div className="table-corner">
        {!connected && <span className="status warn">Reconnecting…</span>}
        <span>
          Join: <strong>{window.location.host}/join</strong> · code <strong>{code}</strong>
        </span>
        {state.campaign && <span>{state.campaign.name}</span>}
        <ScaleBar pxPer5ft={scale} />
        {!state.table.calibrated && <span className="hint">Not calibrated: the DM can calibrate for miniatures.</span>}
      </div>
    </main>
  );
}

function state_campaign(state: RoomState | null) {
  return state?.campaign ? (
    <p className="campaign-title">
      Campaign: <strong>{state.campaign.name}</strong>
    </p>
  ) : null;
}

/** A small ruler on the Main Screen: how long 10 feet is on the table. */
function ScaleBar({ pxPer5ft }: { pxPer5ft: number }) {
  const { unit } = useSettings();
  return (
    <span className="scale-bar">
      <span className="scale-line" style={{ width: pxPer5ft * 2 }} />
      {unit === 'm' ? '3 m' : '10 ft'}
    </span>
  );
}
