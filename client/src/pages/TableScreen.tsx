import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { SEATS, type Member } from '../../../shared/protocol.ts';
import { clientId, loadSession, request, saveSession } from '../socket.ts';
import { useConnected, useOnConnect, useRoomState } from '../hooks.ts';
import { SIDE_ROTATION } from '../seats.ts';

/** Opens (or re-opens) this device's game. Shared so a double call can't create two games. */
let opening: Promise<string> | null = null;
async function openRoom(): Promise<string> {
  const saved = loadSession('table');
  if (saved) {
    try {
      await request('room:rejoin', { clientId, code: saved.code });
      return saved.code;
    } catch {
      // the old game is gone (e.g. server restarted): make a new one
    }
  }
  const { code } = await request('room:create', { clientId });
  saveSession({ code, role: 'table' }, 'table');
  return code;
}

export function TableScreen() {
  const connected = useConnected();
  const [state] = useRoomState();
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useOnConnect(() => {
    opening ??= openRoom().finally(() => {
      opening = null;
    });
    opening.then(
      (c) => {
        setCode(c);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const joinUrl = code ? `${window.location.origin}/join?code=${code}` : '';
  useEffect(() => {
    if (!joinUrl) return;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#2b2118', light: '#fbf6ea' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinUrl]);

  const members = state?.code === code ? state.members : [];
  const dm = members.find((m) => m.role === 'dm');
  const players = members.filter((m) => m.role === 'player');

  function newGame() {
    if (!confirm('Start a new game? Everyone will need to join again.')) return;
    setCode(null);
    request('room:create', { clientId }).then(({ code: c }) => {
      saveSession({ code: c, role: 'table' }, 'table');
      setCode(c);
    });
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

      <section className="table-center">
        <h1 className="title small">dnd</h1>
        {error && <p className="error">{error}</p>}
        {!connected && <p className="status warn">Connecting to the server…</p>}
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
            <button className="link-button" onClick={newGame}>Start a new game</button>
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
