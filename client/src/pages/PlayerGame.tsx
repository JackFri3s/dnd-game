import { useState } from 'react';
import type { Member, RoomState } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { nextPanelSide, usePanelSide } from '../settings.ts';
import { SIDE_ICON } from '../seats.ts';
import { MapBoard, type Camera } from '../components/MapBoard.tsx';
import { ActionPanel, AimBar, useAim } from '../components/Actions.tsx';
import { useRules } from '../rules/index.ts';
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
    const at = myToken ? { x: myToken.x, y: myToken.y } : state.view;
    return { ...at, scale: 56 };
  });
  const [menu, setMenu] = useState(false);
  const side = usePanelSide();
  const [showCharacter, setShowCharacter] = useState(false);
  const myCharacter = state.characters.find((c) => c.ownerId === me.id) ?? null;
  const rules = useRules(state.homebrew);
  const aimState = useAim(store, state);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const dm = state.members.find((m) => m.role === 'dm');

  return (
    <div className={`game-layout panel-${side}`} data-testid="player-game">
      <header className="game-bar">
        <span className="badge-dot big" style={{ background: me.color }} />
        <strong className="grow">{myCharacter?.name ?? me.name}</strong>
        <button className="button small" onClick={() => setShowCharacter(true)} data-testid="open-character">
          {myCharacter ? 'Character' : 'Create character'}
        </button>
        <button className="button small" onClick={() => myToken && setCamera({ ...camera, ...{ x: myToken.x, y: myToken.y } })}>
          Find me
        </button>
        <button className="button small" onClick={() => nextPanelSide(side)} aria-label="Move the controls" title="Move the controls to another side">
          {SIDE_ICON[side]}
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
      <div className="game-body">
      <div className="game-board">
        <MapBoard
          state={state}
          camera={camera}
          onCameraChange={setCamera}
          canDrag={(t) => t.ownerId === me.id}
          onMoveToken={(token, to) => run(store.request('token:move', { tokenId: token.id, x: to.x, y: to.y }))}
          selectedTokenId={myToken?.id}
          onTapMap={aimState.aim ? aimState.tapMap : undefined}
          areaPreview={aimState.preview}
        />
      </div>
      <footer className="game-controls">
        {error && <p className="error">{error}</p>}
        {myToken ? (
          aimState.aim ? (
            <AimBar aimState={aimState} character={myCharacter} rules={rules} />
          ) : (
            <>
              <p className="hint">Drag your token to move it. Tap to show on every screen:</p>
              <ActionPanel
                store={store}
                state={state}
                token={myToken}
                character={myCharacter}
                rules={rules}
                aimState={aimState}
                canRemoveArea={(a) => a.placedBy === me.id}
              />
            </>
          )
        ) : (
          <p className="hint">Your token will appear when the Dungeon Master places it.</p>
        )}
      </footer>
      </div>
    </div>
  );
}
