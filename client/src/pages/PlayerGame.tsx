import { useState } from 'react';
import type { Highlight, Member, RoomState } from '../../../shared/protocol.ts';
import { hexToPoint } from '../../../shared/hex.ts';
import type { GameStore } from '../game.ts';
import { HexBoard, type Camera } from '../components/HexBoard.tsx';

const RANGES = [5, 30, 60, 120];

/** A player's phone during play: their own view of the map, and their token's controls. */
export function PlayerGame({
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
  const myToken = state.tokens.find((t) => t.ownerId === me.id) ?? null;
  const [camera, setCamera] = useState<Camera>(() => {
    const at = myToken ? hexToPoint(myToken) : state.view;
    return { ...at, scale: 56 };
  });
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const mine = myToken && state.highlight?.tokenId === myToken.id ? state.highlight : null;
  const show = (h: Omit<Highlight, 'tokenId'> | null) =>
    myToken && run(store.request('highlight:set', { highlight: h && { ...h, tokenId: myToken.id } }));
  const dm = state.members.find((m) => m.role === 'dm');

  return (
    <div className="game-layout" data-testid="player-game">
      <header className="game-bar">
        <span className="badge-dot big" style={{ background: me.color }} />
        <strong className="grow">{me.name}</strong>
        <button className="small-button" onClick={() => myToken && setCamera({ ...camera, ...hexToPoint(myToken) })}>
          ◎ Find me
        </button>
        <button className="small-button" onClick={() => setMenu(!menu)} aria-expanded={menu}>☰</button>
      </header>
      {menu && (
        <div className="game-menu">
          <p className="hint">Game {state.code} · DM: {dm?.name ?? 'none yet'}</p>
          {!dm && <button className="link-button" onClick={onSwitchRole}>Be the Dungeon Master instead</button>}
          <button className="link-button" onClick={() => store.leave()}>Leave game</button>
        </div>
      )}
      <div className="game-board">
        <HexBoard
          state={state}
          camera={camera}
          onCameraChange={setCamera}
          canDrag={(t) => t.ownerId === me.id}
          onMoveToken={(token, hex) => run(store.request('token:move', { tokenId: token.id, ...hex }))}
          selectedTokenId={myToken?.id}
        />
      </div>
      <footer className="game-controls">
        {error && <p className="error">{error}</p>}
        {myToken ? (
          <>
            <p className="hint">Drag your token to move it. Show on every screen:</p>
            <div className="chip-row">
              <button
                className={`chip ${mine?.kind === 'move' ? 'on' : ''}`}
                onClick={() => show({ kind: 'move', feet: myToken.speedFt })}
              >
                🥾 Movement {myToken.speedFt} ft
              </button>
              {RANGES.map((ft) => (
                <button
                  key={ft}
                  className={`chip ${mine?.kind === 'range' && mine.feet === ft ? 'on' : ''}`}
                  onClick={() => show({ kind: 'range', feet: ft })}
                >
                  🎯 {ft === 5 ? 'Reach 5 ft' : `${ft} ft`}
                </button>
              ))}
              {mine && (
                <button className="chip" onClick={() => show(null)}>
                  ✕ Hide
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="hint">Your token will appear when the Dungeon Master places it.</p>
        )}
      </footer>
    </div>
  );
}
