import { useState } from 'react';
import type { Highlight, Member, RoomState } from '../../../shared/protocol.ts';
import { hexToPoint } from '../../../shared/hex.ts';
import type { GameStore } from '../game.ts';
import { HexBoard, type Camera } from '../components/HexBoard.tsx';
import { RangeChips } from '../components/RangeChips.tsx';
import { CharacterScreen } from '../characters/CharacterScreen.tsx';

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
  const [showCharacter, setShowCharacter] = useState(false);
  const myCharacter = state.characters.find((c) => c.ownerId === me.id) ?? null;
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const show = (h: Omit<Highlight, 'tokenId'> | null) =>
    myToken && run(store.request('highlight:set', { highlight: h && { ...h, tokenId: myToken.id } }));
  const dm = state.members.find((m) => m.role === 'dm');

  return (
    <div className="game-layout" data-testid="player-game">
      <header className="game-bar">
        <span className="badge-dot big" style={{ background: me.color }} />
        <strong className="grow">{myCharacter?.name ?? me.name}</strong>
        <button className="button small" onClick={() => setShowCharacter(true)} data-testid="open-character">
          {myCharacter ? 'Character' : 'Create character'}
        </button>
        <button className="button small" onClick={() => myToken && setCamera({ ...camera, ...hexToPoint(myToken) })}>
          Find me
        </button>
        <button className="button small" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Menu">☰</button>
      </header>
      {menu && (
        <div className="game-menu">
          <p className="hint">
            {state.campaign?.name} · game {state.code} · DM: {dm?.name ?? 'none yet'}
          </p>
          {!dm && <button className="text-button" onClick={onSwitchRole}>Be the Dungeon Master instead</button>}
          <a className="text-button" href="/settings">Settings</a>
          <button className="text-button" onClick={() => store.leave()}>Leave game</button>
        </div>
      )}
      {showCharacter && <CharacterScreen store={store} character={myCharacter} editable onClose={() => setShowCharacter(false)} />}
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
            <RangeChips
              token={myToken}
              highlight={state.highlight?.tokenId === myToken.id ? state.highlight : null}
              onShow={show}
            />
          </>
        ) : (
          <p className="hint">Your token will appear when the Dungeon Master places it.</p>
        )}
      </footer>
    </div>
  );
}
