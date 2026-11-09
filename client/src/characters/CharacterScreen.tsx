import { useEffect, useState } from 'react';
import type { Character } from '../../../shared/rules.ts';
import type { DiceRoll } from '../../../shared/protocol.ts';
import { useGame, type GameStore } from '../game.ts';
import { HomebrewPanel } from './HomebrewPanel.tsx';
import { useRules } from '../rules/index.ts';
import { CharacterSheet } from './CharacterSheet.tsx';
import { CharacterBuilder } from './CharacterBuilder.tsx';
import { CharacterEditor } from './CharacterEditor.tsx';
import { QuickRoll } from './QuickRoll.tsx';
import { LevelUp } from './LevelUp.tsx';

type Mode = 'sheet' | 'choose' | 'builder' | 'editor' | 'quick' | 'levelup' | 'homebrew';

/**
 * Everything about one character, as a full-screen panel: create one (guided or
 * by entering an existing one), view the sheet, edit it.
 */
export function CharacterScreen({
  store,
  character,
  editable,
  onClose,
}: {
  store: GameStore;
  character: Character | null;
  editable: boolean;
  onClose: () => void;
}) {
  const game = useGame(store);
  const rules = useRules(game.state?.homebrew);
  const [mode, setMode] = useState<Mode>(character ? 'sheet' : 'choose');
  const [lastRoll, setLastRoll] = useState<DiceRoll | null>(null);
  // The roll result disappears after a few seconds.
  useEffect(() => {
    if (!lastRoll) return;
    const t = setTimeout(() => setLastRoll(null), 6000);
    return () => clearTimeout(t);
  }, [lastRoll]);

  const save = async (c: Character) => {
    await store.request('character:save', { character: c });
  };
  const saveAndShow = async (c: Character) => {
    await save(c);
    setMode('sheet');
    if (!character) onClose();
  };
  const rollDice = async (label: string, groups: { count: number; sides: number; dropLowest?: number }[], modifier = 0) => {
    const { roll } = await store.request('dice:roll', { label, groups, modifier });
    return roll;
  };

  async function remove() {
    if (!character || !confirm(`Delete ${character.name}? This can't be undone (except by going back to a save point).`)) return;
    await store.request('character:delete', { characterId: character.id });
    onClose();
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="overlay-inner">
        {mode === 'sheet' && (
          <header className="builder-head">
            <button className="text-button" onClick={onClose}>
              ← Close
            </button>
          </header>
        )}
        {!rules ? (
          <p className="hint">Loading the rules…</p>
        ) : mode === 'choose' ? (
          <div className="stack">
            <header className="builder-head">
              <button className="text-button" onClick={onClose}>← Back</button>
            </header>
            <h2>New character</h2>
            <button className="choice" onClick={() => setMode('quick')} data-testid="choose-quick">
              <strong>Roll me a character</strong>
              <span className="hint">A few questions (or none), real dice, and a ready level-1 character. Keep it or roll again.</span>
            </button>
            <button className="choice" onClick={() => setMode('builder')} data-testid="choose-builder">
              <strong>Create one step by step</strong>
              <span className="hint">Choose a class, origin and abilities (roll dice or use the standard numbers). The app does the maths.</span>
            </button>
            <button className="choice" onClick={() => setMode('editor')} data-testid="choose-editor">
              <strong>Enter an existing character</strong>
              <span className="hint">Already have a character on paper or in another app? Fill it in here.</span>
            </button>
            <button className="text-button" onClick={() => setMode('homebrew')} data-testid="choose-homebrew">
              Make custom content first (your own species, class, spell or item)
            </button>
          </div>
        ) : mode === 'homebrew' ? (
          <div className="stack">
            <header className="builder-head">
              <button className="text-button" onClick={() => setMode(character ? 'sheet' : 'choose')}>← Back</button>
            </header>
            <h2>Custom content</h2>
            <HomebrewPanel store={store} homebrew={game.state!.homebrew} rules={rules} myId={game.me?.id ?? ''} isDm={game.me?.role === 'dm'} />
          </div>
        ) : mode === 'levelup' && character ? (
          <LevelUp character={character} rules={rules} rollDice={(label, groups, modifier) => rollDice(label, groups, modifier)} onSave={saveAndShow} onCancel={() => setMode('sheet')} />
        ) : mode === 'quick' ? (
          <QuickRoll rules={rules} rollDice={(label, groups) => rollDice(label, groups)} onSave={saveAndShow} onCancel={() => setMode('choose')} />
        ) : mode === 'builder' ? (
          <CharacterBuilder rules={rules} rollDice={(label, groups) => rollDice(label, groups)} onSave={saveAndShow} onCancel={() => (character ? setMode('sheet') : setMode('choose'))} />
        ) : mode === 'editor' ? (
          <CharacterEditor
            rules={rules}
            initial={character ?? undefined}
            onSave={saveAndShow}
            onCancel={() => (character ? setMode('sheet') : setMode('choose'))}
            onDelete={character ? remove : undefined}
          />
        ) : character ? (
          <>
            <CharacterSheet
              character={character}
              rules={rules}
              editable={editable}
              onSave={save}
              onEdit={() => setMode('editor')}
              onLevelUp={() => setMode('levelup')}
              onRoll={
                editable
                  ? (label, modifier, dice) => rollDice(label, dice?.length ? dice : [{ count: 1, sides: 20 }], modifier).then(setLastRoll, () => {})
                  : undefined
              }
            />
            {lastRoll && (
              <div className="roll-toast" onClick={() => setLastRoll(null)} data-testid="roll-result">
                <strong>{lastRoll.total}</strong>
                <span>
                  {lastRoll.label.replace(/^.*?: /, '')} · {lastRoll.groups.map((g) => `${g.rolls.length}d${g.sides} (${g.rolls.join(', ')})`).join(' + ')}
                  {lastRoll.modifier ? ` ${lastRoll.modifier > 0 ? '+' : '−'} ${Math.abs(lastRoll.modifier)}` : ''}
                </span>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
