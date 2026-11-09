import { useState } from 'react';
import type { Character, RulesData } from '../../../shared/rules.ts';
import type { DiceRoll } from '../../../shared/protocol.ts';
import { CharacterSheet } from './CharacterSheet.tsx';
import { quickCharacter } from './assemble.ts';

/** "Roll me a character": a few optional choices, real dice, and a ready level-1 character. */
export function QuickRoll({
  rules,
  rollDice,
  onSave,
  onCancel,
}: {
  rules: RulesData;
  rollDice: (label: string, groups: { count: number; sides: number; dropLowest?: number }[]) => Promise<DiceRoll>;
  onSave: (c: Character) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState({ classIndex: '', speciesIndex: '', backgroundIndex: '', name: '' });
  const [result, setResult] = useState<Character | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function roll() {
    setBusy(true);
    setError(null);
    try {
      const r = await rollDice(`${choice.name.trim() ? `${choice.name.trim()}: ` : ''}rolling a new character (4d6, drop lowest)`, Array.from({ length: 6 }, () => ({ count: 4, sides: 6, dropLowest: 1 })));
      setResult(quickCharacter(rules, choice, r.groups.map((g) => g.total)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    if (!result) return;
    setBusy(true);
    try {
      await onSave(result);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="stack" data-testid="quick-result">
        <header className="builder-head">
          <button className="text-button" onClick={() => setResult(null)}>← Change choices</button>
        </header>
        <CharacterSheet character={result} rules={rules} editable={false} onSave={async () => {}} onEdit={() => {}} />
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="button block" onClick={roll} disabled={busy}>Roll again</button>
          <button className="button primary block" onClick={keep} disabled={busy} data-testid="keep-character">Keep this character</button>
        </div>
      </div>
    );
  }

  const select = (label: string, key: 'classIndex' | 'speciesIndex' | 'backgroundIndex', options: { index: string; name: string }[]) => (
    <label>
      {label}
      <select value={choice[key]} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })} aria-label={label}>
        <option value="">Surprise me</option>
        {options.map((o) => (
          <option key={o.index} value={o.index}>{o.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="stack-sm" data-testid="quick-roll">
      <header className="builder-head">
        <button className="text-button" onClick={onCancel}>← Back</button>
      </header>
      <h2>Roll me a character</h2>
      <p className="hint">Answer what you like, leave the rest to chance. The dice are rolled for everyone to see; you get a ready level-1 character to keep or roll again.</p>
      {select('What class?', 'classIndex', rules.classes)}
      {select('What species?', 'speciesIndex', rules.species)}
      {select('What background?', 'backgroundIndex', rules.backgrounds)}
      <label>
        A name for them?
        <input value={choice.name} onChange={(e) => setChoice({ ...choice, name: e.target.value })} placeholder="Leave empty for a random name" maxLength={40} aria-label="Name for them" />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="button primary block" onClick={roll} disabled={busy} data-testid="roll-character">
        {busy ? 'Rolling…' : 'Roll the dice'}
      </button>
    </div>
  );
}
