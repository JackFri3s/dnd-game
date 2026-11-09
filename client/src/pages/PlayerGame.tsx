import { useEffect, useState } from 'react';
import type { Entrance } from '../../../shared/places.ts';
import type { Member, RoomState } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { nextPanelSide, usePanelSide } from '../settings.ts';
import { SIDE_ICON } from '../seats.ts';
import { MapBoard, type Camera } from '../components/MapBoard.tsx';
import { ActionPanel, AimBar, useAim, useLocalHighlight } from '../components/Actions.tsx';
import { CombatBar, RollResult, TargetBar, combatInfo, useTargeting } from '../components/Combat.tsx';
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
  const highlight = useLocalHighlight();
  const aimState = useAim(store, state, highlight);
  const targeting = useTargeting(store, state, highlight);
  const { current, movedFt } = combatInfo(state);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const dm = state.members.find((m) => m.role === 'dm');
  const [entrance, setEntrance] = useState<Entrance | null>(null);
  const [asked, setAsked] = useState(false);

  // The party went somewhere new: look at where you arrived.
  useEffect(() => {
    const t = state.tokens.find((x) => x.ownerId === me.id);
    setCamera((c) => ({ ...c, ...(t ? { x: t.x, y: t.y } : state.view) }));
    setEntrance(null);
    setError(null);
  }, [state.placeId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`game-layout panel-${side}`} data-testid="player-game">
      <header className="game-bar">
        <span className="badge-dot big" style={{ background: me.color }} />
        <strong className="grow">{myCharacter?.name ?? me.name}</strong>
        <button className="button small" onClick={() => setShowCharacter(true)} data-testid="open-character">
          {myCharacter ? 'Sheet' : 'Create character'}
        </button>
        <button className="icon-btn" onClick={() => myToken && setCamera({ ...camera, x: myToken.x, y: myToken.y })} aria-label="Find me" title="Find me">
          ◎
        </button>
        <button className="icon-btn" onClick={() => nextPanelSide(side)} aria-label="Move the controls" title="Move the controls to another side">
          {SIDE_ICON[side]}
        </button>
        <button className={`icon-btn ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Menu">
          ☰
        </button>
      </header>
      {menu && (
        <div className="game-menu">
          <p className="hint">
            {state.campaign?.name} · game {state.code} · DM: {dm?.name ?? 'none yet'}
          </p>
          <div className="button-row">
            <a className="button" href="/settings">Settings</a>
            {!dm && <button className="button" onClick={onSwitchRole}>Be the Dungeon Master</button>}
            <button className="button danger" onClick={() => store.leave()}>Leave game</button>
          </div>
        </div>
      )}
      <RollResult roll={targeting.result} onClose={targeting.clearResult} />
      {showCharacter && <CharacterScreen store={store} character={myCharacter} editable onClose={() => setShowCharacter(false)} />}
      <div className="game-body">
        <div className="game-board">
          <MapBoard
            state={state}
            camera={camera}
            onCameraChange={setCamera}
            canDrag={(t) => t.ownerId === me.id}
            onMoveToken={(token, to) =>
              // the map needs the refusal too, to put the token back
              store.request('token:move', { tokenId: token.id, x: to.x, y: to.y }).then(
                () => setError(null),
                (e: Error) => {
                  setError(e.message);
                  throw e;
                },
              )
            }
            selectedTokenId={myToken?.id}
            onTapMap={aimState.aim ? aimState.tapMap : targeting.pending ? targeting.tap : undefined}
            areaPreview={aimState.preview}
            movedFt={movedFt}
            currentTokenId={current?.id ?? null}
            localHighlight={highlight.local}
            onTapEntrance={(e) => {
              setEntrance(e);
              setAsked(false);
            }}
            selectedEntranceId={entrance?.id}
          />
        </div>
        <footer className="game-controls">
          {error && (
            <p className="error" onClick={() => setError(null)}>
              {error}
            </p>
          )}
          <CombatBar store={store} state={state} token={myToken} />
          {!myToken ? (
            <p className="hint">Your token will appear when the Dungeon Master starts the game.</p>
          ) : entrance ? (
            <div className="stack-sm" data-testid="entrance-bar">
              <div className="entrance-bar">
                <div className="grow">
                  <strong>{entrance.name}</strong>
                  <div className="hint">{asked ? 'The Dungeon Master has been asked.' : 'The Dungeon Master decides when the party goes through.'}</div>
                </div>
                <button className="icon-btn" onClick={() => setEntrance(null)} aria-label="Close">
                  ✕
                </button>
              </div>
              <button
                className="button primary block"
                disabled={asked}
                onClick={() => run(store.request('place:enter', { entranceId: entrance.id }).then(() => setAsked(true)))}
                data-testid="ask-enter"
              >
                {entrance.kind === 'exit' ? 'Ask to leave' : 'Ask to go in'}
              </button>
            </div>
          ) : targeting.pending ? (
            <TargetBar targeting={targeting} />
          ) : aimState.aim ? (
            <AimBar aimState={aimState} character={myCharacter} rules={rules} />
          ) : (
            <ActionPanel
              store={store}
              state={state}
              token={myToken}
              character={myCharacter}
              rules={rules}
              aimState={aimState}
              canRemoveArea={(a) => a.placedBy === me.id}
              targeting={targeting}
              highlight={highlight}
            />
          )}
        </footer>
      </div>
    </div>
  );
}
