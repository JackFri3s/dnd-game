import { useState } from 'react';
import {
  ABILITIES,
  ABILITY_NAMES,
  classChoiceLevels,
  allFeats,
  mod,
  withSummary,
  type Ability,
  type Character,
  type RulesData,
} from '../../../shared/rules.ts';
import type { DiceRoll } from '../../../shared/protocol.ts';
import { RuleChoices } from './RuleChoices.tsx';
import { choicesComplete } from './choices.ts';

/**
 * Levelling up, step by step: hit points (roll or average), new features,
 * subclass, ability score improvement or feat, new spells and any new choices.
 */
export function LevelUp({
  character: c,
  rules,
  rollDice,
  onSave,
  onCancel,
}: {
  character: Character;
  rules: RulesData;
  rollDice: (label: string, groups: { count: number; sides: number }[], modifier?: number) => Promise<DiceRoll>;
  onSave: (c: Character) => Promise<unknown>;
  onCancel: () => void;
}) {
  const cls = rules.classes.find((x) => x.index === c.classIndex);
  const level = c.level + 1;
  const levels = classChoiceLevels(cls);
  const oldRow = cls?.levels.find((l) => l.level === c.level);
  const row = cls?.levels.find((l) => l.level === level);
  const conMod = mod(c.abilities.con);
  const hitDie = cls?.hitDie ?? 8;
  const dwarf = c.speciesIndex === 'dwarf' ? 1 : 0;

  const [hpRoll, setHpRoll] = useState<number | null>(null);
  const [hpMode, setHpMode] = useState<'average' | 'roll'>('average');
  const [subclass, setSubclass] = useState(c.subclassIndex ?? '');
  const [improve, setImprove] = useState<'asi' | 'feat'>('asi');
  const [asi, setAsi] = useState<Partial<Record<Ability, number>>>({});
  const [feat, setFeat] = useState('');
  const [boonAbility, setBoonAbility] = useState<Ability | ''>('');
  const [cantrips, setCantrips] = useState<string[]>([]);
  const [spells, setSpells] = useState<string[]>([]);
  const [choices, setChoices] = useState(c.choices ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!cls || c.level >= 20) {
    return (
      <div className="stack">
        <p>{c.level >= 20 ? 'This character is already level 20.' : 'Choose a class first (Edit).'}</p>
        <button className="button" onClick={onCancel}>Back</button>
      </div>
    );
  }

  const average = Math.floor(hitDie / 2) + 1;
  const hpGain = Math.max(1, (hpMode === 'roll' && hpRoll !== null ? hpRoll : average) + conMod) + dwarf;
  const isAsi = levels.asi.includes(level);
  const isBoon = levels.epicBoon.includes(level);
  const isSubclass = levels.subclass.includes(level) && !c.subclassIndex;
  const asiTotal = Object.values(asi).reduce((a, b) => a + (b ?? 0), 0);
  const feats = allFeats(c);
  const featOptions = rules.feats.filter(
    (f) => (isBoon ? f.type === 'epic-boon' : f.type === 'general' && f.index !== 'ability-score-improvement') && (f.minLevel ?? 1) <= level && !feats.includes(f.index),
  );
  const newCantrips = Math.max(0, (row?.cantrips ?? 0) - (oldRow?.cantrips ?? 0));
  const newSpells = Math.max(0, (row?.prepared ?? 0) - (oldRow?.prepared ?? 0));
  const maxSpellLevel = (row?.slots ?? []).reduce((m, n, i) => (n > 0 ? i + 1 : m), 0);
  const classSpells = rules.spells.filter((s) => s.classes.includes(cls.index));
  const newFeatures = rules.features.filter(
    (f) => f.class === cls.index && f.level === level && !/subclass$|ability-score-improvement$|epic-boon$/.test(f.index) && (!f.subclass || f.subclass === (subclass || c.subclassIndex)),
  );

  // The character after levelling, so new rule choices (e.g. expertise) can be shown.
  const abilities = { ...c.abilities };
  if (isAsi && improve === 'asi') for (const a of ABILITIES) abilities[a] = Math.min(20, abilities[a] + (asi[a] ?? 0));
  if (isBoon && boonAbility) abilities[boonAbility] = Math.min(30, abilities[boonAbility] + 1);
  const levelUpRecord = {
    level,
    hp: hpGain,
    ...(isAsi && improve === 'asi' ? { asi } : {}),
    ...(((isAsi && improve === 'feat') || isBoon) && feat ? { feat } : {}),
  };
  const next: Character = {
    ...c,
    level,
    abilities,
    subclassIndex: subclass || c.subclassIndex,
    hp: { ...c.hp, max: c.hp.max + hpGain, current: c.hp.current + hpGain },
    cantrips: [...c.cantrips, ...cantrips],
    spells: [...c.spells, ...spells],
    choices: { ...choices, levelUps: [...(choices.levelUps ?? []), levelUpRecord] },
  };

  const ready =
    (hpMode === 'average' || hpRoll !== null) &&
    (!isSubclass || !!subclass) &&
    (!isAsi || (improve === 'asi' ? asiTotal === 2 : !!feat)) &&
    (!isBoon || (!!feat && !!boonAbility)) &&
    cantrips.length === Math.min(newCantrips, classSpells.filter((s) => s.level === 0).length) &&
    spells.length === newSpells &&
    choicesComplete(next, rules);

  async function rollHp() {
    try {
      const r = await rollDice(`${c.name}: hit points for level ${level}`, [{ count: 1, sides: hitDie }]);
      setHpRoll(r.groups[0].total);
      setHpMode('roll');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onSave(withSummary(next, rules));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const spellPicker = (title: string, list: typeof classSpells, chosen: string[], max: number, setChosen: (v: string[]) => void) => (
    <fieldset>
      <legend>
        {title} ({chosen.length}/{max})
      </legend>
      <div className="pill-grid">
        {list
          .filter((s) => !c.cantrips.includes(s.index) && !c.spells.includes(s.index))
          .map((s) => {
            const on = chosen.includes(s.index);
            return (
              <button key={s.index} className={`pill ${on ? 'prof on' : ''}`} disabled={!on && chosen.length >= max} onClick={() => setChosen(on ? chosen.filter((x) => x !== s.index) : [...chosen, s.index])}>
                {s.name}
                {s.level > 0 && <span className="hint"> L{s.level}</span>}
              </button>
            );
          })}
      </div>
    </fieldset>
  );

  return (
    <div className="stack-sm" data-testid="level-up">
      <header className="builder-head">
        <button className="text-button" onClick={onCancel}>← Cancel</button>
      </header>
      <h2>
        {c.name}: level {c.level} → {level}
      </h2>

      <fieldset>
        <legend>Hit points</legend>
        <div className="segmented">
          <button className={hpMode === 'average' ? 'on' : ''} onClick={() => setHpMode('average')}>
            Take the average ({average})
          </button>
          <button className={hpMode === 'roll' ? 'on' : ''} onClick={rollHp} data-testid="roll-hp">
            {hpRoll !== null ? `Rolled ${hpRoll} (roll again)` : `Roll 1d${hitDie}`}
          </button>
        </div>
        <p>
          You gain <strong data-testid="hp-gain">{hpGain}</strong> hit points ({hpMode === 'roll' && hpRoll !== null ? `rolled ${hpRoll}` : `average ${average}`} {conMod >= 0 ? '+' : '−'} {Math.abs(conMod)} Constitution
          {dwarf ? ' + 1 Dwarven Toughness' : ''}): {c.hp.max} → {c.hp.max + hpGain}.
        </p>
      </fieldset>

      {isSubclass && (
        <fieldset>
          <legend>Choose your subclass</legend>
          <div className="choice-list">
            {cls.subclasses.map((s) => (
              <button key={s.index} className={`choice ${subclass === s.index ? 'on' : ''}`} onClick={() => setSubclass(s.index)}>
                <strong>{s.name}</strong>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {newFeatures.length > 0 && (
        <fieldset>
          <legend>New features</legend>
          {newFeatures.map((f) => (
            <p key={f.index}>
              <strong>{f.name}</strong> <span className="hint">— {f.description.split(/(?<=\.)\s/)[0]}</span>
            </p>
          ))}
        </fieldset>
      )}

      {isAsi && (
        <fieldset>
          <legend>Ability Score Improvement</legend>
          <div className="segmented">
            <button className={improve === 'asi' ? 'on' : ''} onClick={() => setImprove('asi')}>+2 to abilities</button>
            <button className={improve === 'feat' ? 'on' : ''} onClick={() => setImprove('feat')}>A feat instead</button>
          </div>
          {improve === 'asi' ? (
            <>
              <p className="hint">Add 2 points: +2 to one ability or +1 to two ({asiTotal}/2). Maximum 20.</p>
              <div className="ability-table">
                {ABILITIES.map((a) => (
                  <div key={a} className="ability-line">
                    <span className="grow">{ABILITY_NAMES[a]}</span>
                    <span className="stepper">
                      <button className="button small" disabled={!asi[a]} onClick={() => setAsi({ ...asi, [a]: (asi[a] ?? 0) - 1 })} aria-label={`Lower ${ABILITY_NAMES[a]}`}>−</button>
                      <span>{asi[a] ? `+${asi[a]}` : ''}</span>
                      <button
                        className="button small"
                        disabled={asiTotal >= 2 || c.abilities[a] + (asi[a] ?? 0) >= 20}
                        onClick={() => setAsi({ ...asi, [a]: (asi[a] ?? 0) + 1 })}
                        aria-label={`Raise ${ABILITY_NAMES[a]}`}
                      >
                        +
                      </button>
                    </span>
                    <strong className="final">{abilities[a]}</strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="choice-list">
              {featOptions.map((f) => (
                <button key={f.index} className={`choice ${feat === f.index ? 'on' : ''}`} onClick={() => setFeat(f.index)}>
                  <strong>{f.name}</strong>
                  <span className="hint">{f.description.replace(/\*\*/g, '').slice(0, 180)}</span>
                </button>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {isBoon && (
        <fieldset>
          <legend>Epic Boon</legend>
          <label>
            +1 to (maximum 30)
            <select value={boonAbility} onChange={(e) => setBoonAbility(e.target.value as Ability)}>
              <option value="">Choose…</option>
              {ABILITIES.map((a) => (
                <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
              ))}
            </select>
          </label>
          <div className="choice-list">
            {featOptions.map((f) => (
              <button key={f.index} className={`choice ${feat === f.index ? 'on' : ''}`} onClick={() => setFeat(f.index)}>
                <strong>{f.name}</strong>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {newCantrips > 0 && spellPicker('New cantrips', classSpells.filter((s) => s.level === 0), cantrips, newCantrips, setCantrips)}
      {newSpells > 0 &&
        spellPicker(`New prepared spells (up to level ${maxSpellLevel})`, classSpells.filter((s) => s.level >= 1 && s.level <= maxSpellLevel), spells, newSpells, setSpells)}
      {row?.slots && row.slots.some((n, i) => n !== (oldRow?.slots?.[i] ?? 0)) && (
        <p className="hint">
          Spell slots now: {row.slots.map((n, i) => (n ? `level ${i + 1}: ${n}` : '')).filter(Boolean).join(', ')}.
        </p>
      )}

      <fieldset>
        <legend>Other choices</legend>
        <RuleChoices character={next} rules={rules} onChange={(ch) => setChoices({ ...ch, levelUps: choices.levelUps })} />
      </fieldset>

      {error && <p className="error">{error}</p>}
      <button className="button primary block" disabled={!ready || busy} onClick={confirm} data-testid="confirm-level-up">
        {busy ? 'Saving…' : `Become level ${level}`}
      </button>
    </div>
  );
}
