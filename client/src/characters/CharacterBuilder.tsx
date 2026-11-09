import { useMemo, useState } from 'react';
import {
  ABILITIES,
  ABILITY_NAMES,
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  STANDARD_ARRAY,
  emptyCharacter,
  mod,
  signed,
  withSummary,
  type Ability,
  type Character,
  type EquipmentOption,
  type RulesData,
} from '../../../shared/rules.ts';
import type { DiceRoll } from '../../../shared/protocol.ts';
import { CLASS_BLURBS, STANDARD_LANGUAGES, randomName } from '../rules/index.ts';
import { formatDistance, useSettings } from '../settings.ts';
import { CharacterSheet } from './CharacterSheet.tsx';
import { expandEquipment } from './assemble.ts';

type Method = 'roll' | 'array' | 'pointbuy';
const STEPS = ['Class', 'Origin', 'Abilities', 'Skills', 'Equipment', 'Spells', 'Details', 'Review'] as const;
type Step = (typeof STEPS)[number];

interface Props {
  rules: RulesData;
  /** Rolls dice through the game, so the table sees the rolls. */
  rollDice: (label: string, groups: { count: number; sides: number; dropLowest?: number }[]) => Promise<DiceRoll>;
  onSave: (c: Character) => Promise<unknown>;
  onCancel: () => void;
}

/** Step-by-step character creation following the 2024 rules (level 1). */
export function CharacterBuilder({ rules, rollDice, onSave, onCancel }: Props) {
  const { unit } = useSettings();
  const [step, setStep] = useState<Step>('Class');
  const [classIndex, setClassIndex] = useState('');
  const [backgroundIndex, setBackgroundIndex] = useState('');
  const [speciesIndex, setSpeciesIndex] = useState('');
  const [subspeciesIndex, setSubspeciesIndex] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>('array');
  const [pool, setPool] = useState<number[]>(STANDARD_ARRAY);
  const [rolled, setRolled] = useState<DiceRoll | null>(null);
  const [assigned, setAssigned] = useState<Record<Ability, number | null>>(blankAssign());
  const [pointBuy, setPointBuy] = useState<Record<Ability, number>>({ str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 });
  const [bonusMode, setBonusMode] = useState<'2-1' | '1-1-1'>('2-1');
  const [plus2, setPlus2] = useState<Ability | ''>('');
  const [plus1, setPlus1] = useState<Ability | ''>('');
  const [skills, setSkills] = useState<string[]>([]);
  const [classEquip, setClassEquip] = useState('A');
  const [bgEquip, setBgEquip] = useState('A');
  const [cantrips, setCantrips] = useState<string[]>([]);
  const [spells, setSpells] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [alignment, setAlignment] = useState('');
  const [languages, setLanguages] = useState<string[]>([]);
  const [details, setDetails] = useState(emptyCharacter().details);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cls = rules.classes.find((c) => c.index === classIndex);
  const background = rules.backgrounds.find((b) => b.index === backgroundIndex);
  const species = rules.species.find((s) => s.index === speciesIndex);
  const level1 = cls?.levels[0];
  const isCaster = !!cls?.spellcasting && !!((level1?.cantrips ?? 0) + (level1?.prepared ?? 0));
  const steps = STEPS.filter((s) => s !== 'Spells' || isCaster);

  // ---- ability scores ----
  const base: Record<Ability, number | null> =
    method === 'pointbuy' ? pointBuy : assigned;
  const bonus = (a: Ability) =>
    !background || !background.abilities.includes(a)
      ? 0
      : bonusMode === '1-1-1'
        ? 1
        : a === plus2
          ? 2
          : a === plus1
            ? 1
            : 0;
  const finalScores = Object.fromEntries(ABILITIES.map((a) => [a, Math.min(20, (base[a] ?? 0) + bonus(a))])) as Record<Ability, number>;
  const pointsSpent = ABILITIES.reduce((sum, a) => sum + POINT_BUY_COST[pointBuy[a]], 0);
  const abilitiesDone =
    ABILITIES.every((a) => base[a] !== null) &&
    (method !== 'pointbuy' || pointsSpent <= POINT_BUY_BUDGET) &&
    (bonusMode === '1-1-1' || (plus2 && plus1 && plus2 !== plus1));

  // ---- skills ----
  const bgSkills = background?.skills ?? [];
  const skillChoices = (cls?.skillChoice.from ?? []).filter((s) => !bgSkills.includes(s));
  const skillsNeeded = cls?.skillChoice.choose ?? 0;

  // ---- spells ----
  const classSpells = useMemo(() => rules.spells.filter((s) => s.classes.includes(classIndex)), [rules, classIndex]);

  // ---- the character being built ----
  const character = ((): Character => {
    const c = emptyCharacter();
    const cOpt = cls?.equipment.find((o) => o.label === classEquip);
    const bOpt = background?.equipment.find((o) => o.label === bgEquip);
    const { items, gold } = expandEquipment(rules, [cOpt, bOpt]);
    const hpMax = Math.max(1, (cls?.hitDie ?? 8) + mod(finalScores.con));
    const feats = background ? [background.feat.index] : [];
    return withSummary(
      {
        ...c,
        name: name.trim(),
        classIndex,
        speciesIndex,
        subspeciesIndex,
        backgroundIndex,
        alignment,
        abilities: finalScores,
        abilityMethod: method,
        skills: [...bgSkills, ...skills],
        languages: ['Common', ...languages],
        feats,
        items,
        gold,
        cantrips,
        spells,
        hp: { max: hpMax, current: hpMax, temp: 0 },
        details,
        createdWith: 'builder',
      },
      rules,
    );
  })();

  const canContinue: Record<Step, boolean> = {
    Class: !!cls,
    Origin: !!background && !!species && (!species.subspecies.length || !!subspeciesIndex),
    Abilities: !!abilitiesDone,
    Skills: skills.length === skillsNeeded,
    Equipment: true,
    Spells: cantrips.length === (level1?.cantrips ?? 0) && spells.length === (level1?.prepared ?? 0),
    Details: !!name.trim() && languages.length === 2,
    Review: true,
  };

  const index = steps.indexOf(step);
  const next = () => setStep(steps[Math.min(steps.length - 1, index + 1)]);
  const back = () => (index === 0 ? onCancel() : setStep(steps[index - 1]));

  async function roll() {
    setError(null);
    try {
      const r = await rollDice(`${name.trim() ? `${name.trim()}: ` : ''}ability scores (4d6, drop lowest)`, ABILITIES.map(() => ({ count: 4, sides: 6, dropLowest: 1 })));
      setRolled(r);
      setPool(r.groups.map((g) => g.total));
      setAssigned(blankAssign());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...character, abilities: finalScores });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // Which pool values are still free for an ability's dropdown.
  const freeFor = (a: Ability) => {
    const used = ABILITIES.filter((b) => b !== a && assigned[b] !== null).map((b) => assigned[b]!);
    const left = [...pool];
    for (const u of used) left.splice(left.indexOf(u), 1);
    return left;
  };

  return (
    <div className="builder" data-testid="builder">
      <header className="builder-head">
        <button className="text-button" onClick={back}>← {index === 0 ? 'Cancel' : 'Back'}</button>
        <span className="hint">
          Step {index + 1} of {steps.length}
        </span>
      </header>
      <h2>{step === 'Review' ? 'Your character' : step}</h2>

      {step === 'Class' && (
        <div className="choice-list">
          {rules.classes.map((c) => (
            <button key={c.index} className={`choice ${classIndex === c.index ? 'on' : ''}`} onClick={() => setClassIndex(c.index)}>
              <strong>{c.name}</strong>
              <span>{CLASS_BLURBS[c.index]}</span>
              <span className="hint">
                Hit die d{c.hitDie} · main ability {c.primary.map((a) => ABILITY_NAMES[a]).join(' or ')}
                {c.spellcasting ? ' · casts spells' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {step === 'Origin' && (
        <>
          <h3>Background</h3>
          <p className="hint">What your character did before adventuring. It raises abilities and gives a feat, skills and gear.</p>
          <div className="choice-list">
            {rules.backgrounds.map((b) => (
              <button key={b.index} className={`choice ${backgroundIndex === b.index ? 'on' : ''}`} onClick={() => { setBackgroundIndex(b.index); setPlus2(''); setPlus1(''); setSkills([]); }}>
                <strong>{b.name}</strong>
                <span className="hint">
                  Abilities: {b.abilities.map((a) => a.toUpperCase()).join(', ')} · Feat: {b.feat.name}
                  {b.feat.note ? ` (${b.feat.note})` : ''} · Skills: {b.skills.map((s) => skillName(rules, s)).join(', ')}
                </span>
              </button>
            ))}
          </div>
          <h3>Species</h3>
          <div className="choice-list">
            {rules.species.map((s) => (
              <button key={s.index} className={`choice ${speciesIndex === s.index ? 'on' : ''}`} onClick={() => { setSpeciesIndex(s.index); setSubspeciesIndex(null); }}>
                <strong>{s.name}</strong>
                <span className="hint">
                  {s.size} · speed {formatDistance(s.speed, unit)} · {s.traits.map((t) => rules.traits.find((x) => x.index === t)?.name ?? t).join(', ')}
                </span>
              </button>
            ))}
          </div>
          {species && species.subspecies.length > 0 && (
            <label>
              {species.subspecies[0].name.split(':')[0]}
              <select value={subspeciesIndex ?? ''} onChange={(e) => setSubspeciesIndex(e.target.value || null)} aria-label="Lineage">
                <option value="">Choose…</option>
                {species.subspecies.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.name.replace(/^.*?: /, '')}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {step === 'Abilities' && (
        <>
          <div className="segmented" role="radiogroup" aria-label="Method">
            {(
              [
                ['roll', 'Roll dice'],
                ['array', 'Standard'],
                ['pointbuy', 'Point buy'],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                role="radio"
                aria-checked={method === m}
                className={method === m ? 'on' : ''}
                onClick={() => {
                  setMethod(m);
                  setAssigned(blankAssign());
                  setPool(m === 'roll' ? (rolled ? rolled.groups.map((g) => g.total) : []) : STANDARD_ARRAY);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {method === 'roll' && (
            <div className="stack-sm">
              <p className="hint">Roll 4 six-sided dice six times; the lowest die of each set is dropped. The rolls show on the Main Screen.</p>
              <button className="button block" onClick={roll} data-testid="roll-abilities">
                {rolled ? 'Roll again' : 'Roll ability scores'}
              </button>
              {rolled && (
                <div className="rolled-sets">
                  {rolled.groups.map((g, i) => (
                    <span key={i} className="rolled-set">
                      <strong>{g.total}</strong>
                      <span className="hint">
                        {g.rolls.map((v, j) => (
                          <span key={j} className={g.kept.length < g.rolls.length && j === g.rolls.indexOf(Math.min(...g.rolls)) ? 'dropped' : ''}>
                            {v}
                          </span>
                        ))}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {method === 'array' && <p className="hint">Give each of these numbers to one ability: 15, 14, 13, 12, 10, 8.</p>}
          {method === 'pointbuy' && (
            <p className="hint">
              Spend up to {POINT_BUY_BUDGET} points (scores 8–15). Used: <strong>{pointsSpent}</strong> / {POINT_BUY_BUDGET}
            </p>
          )}
          {cls && <p className="hint">Tip: a {cls.name}'s main ability is {cls.primary.map((a) => ABILITY_NAMES[a]).join(' or ')}.</p>}

          {(method !== 'roll' || rolled) && (
            <div className="ability-table">
              {ABILITIES.map((a) => (
                <div key={a} className="ability-line">
                  <span className="grow">{ABILITY_NAMES[a]}</span>
                  {method === 'pointbuy' ? (
                    <span className="stepper">
                      <button className="button small" disabled={pointBuy[a] <= 8} onClick={() => setPointBuy({ ...pointBuy, [a]: pointBuy[a] - 1 })} aria-label={`Lower ${ABILITY_NAMES[a]}`}>−</button>
                      <span>{pointBuy[a]}</span>
                      <button
                        className="button small"
                        disabled={pointBuy[a] >= 15 || pointsSpent - POINT_BUY_COST[pointBuy[a]] + POINT_BUY_COST[pointBuy[a] + 1] > POINT_BUY_BUDGET}
                        onClick={() => setPointBuy({ ...pointBuy, [a]: pointBuy[a] + 1 })}
                        aria-label={`Raise ${ABILITY_NAMES[a]}`}
                      >
                        +
                      </button>
                    </span>
                  ) : (
                    <select
                      value={assigned[a] ?? ''}
                      onChange={(e) => setAssigned({ ...assigned, [a]: e.target.value === '' ? null : Number(e.target.value) })}
                      aria-label={ABILITY_NAMES[a]}
                    >
                      <option value="">–</option>
                      {[...new Set([...(assigned[a] !== null ? [assigned[a]!] : []), ...freeFor(a)])]
                        .sort((x, y) => y - x)
                        .map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                    </select>
                  )}
                  <span className="bonus">{bonus(a) ? `+${bonus(a)}` : ''}</span>
                  <strong className="final">{base[a] !== null ? finalScores[a] : '–'}</strong>
                  <span className="hint mod">{base[a] !== null ? signed(mod(finalScores[a])) : ''}</span>
                </div>
              ))}
            </div>
          )}

          {background && (
            <fieldset>
              <legend>Background bonus ({background.name})</legend>
              <div className="segmented">
                <button className={bonusMode === '2-1' ? 'on' : ''} onClick={() => setBonusMode('2-1')}>+2 and +1</button>
                <button className={bonusMode === '1-1-1' ? 'on' : ''} onClick={() => setBonusMode('1-1-1')}>+1 to all three</button>
              </div>
              {bonusMode === '2-1' && (
                <div className="row">
                  <label className="grow">
                    +2 to
                    <select value={plus2} onChange={(e) => setPlus2(e.target.value as Ability)} aria-label="Plus 2">
                      <option value="">Choose…</option>
                      {background.abilities.map((a) => (
                        <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grow">
                    +1 to
                    <select value={plus1} onChange={(e) => setPlus1(e.target.value as Ability)} aria-label="Plus 1">
                      <option value="">Choose…</option>
                      {background.abilities.filter((a) => a !== plus2).map((a) => (
                        <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </>
      )}

      {step === 'Skills' && (
        <>
          <p className="hint">
            From your background: {bgSkills.map((s) => skillName(rules, s)).join(', ')}. Choose {skillsNeeded} more from your class ({skills.length}/{skillsNeeded}).
          </p>
          <div className="pill-grid">
            {skillChoices.map((s) => {
              const on = skills.includes(s);
              return (
                <button
                  key={s}
                  className={`pill ${on ? 'prof on' : ''}`}
                  disabled={!on && skills.length >= skillsNeeded}
                  onClick={() => setSkills(on ? skills.filter((x) => x !== s) : [...skills, s])}
                >
                  {skillName(rules, s)}
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === 'Equipment' && (
        <>
          <EquipmentChoice title={`${cls?.name} gear`} options={cls?.equipment ?? []} value={classEquip} onChange={setClassEquip} />
          <EquipmentChoice title={`${background?.name} gear`} options={background?.equipment ?? []} value={bgEquip} onChange={setBgEquip} />
        </>
      )}

      {step === 'Spells' && level1 && (
        <>
          {(level1.cantrips ?? 0) > 0 && (
            <SpellPicker
              title={`Cantrips (${cantrips.length}/${level1.cantrips})`}
              spells={classSpells.filter((s) => s.level === 0)}
              chosen={cantrips}
              max={level1.cantrips!}
              onChange={setCantrips}
            />
          )}
          <SpellPicker
            title={`Level 1 spells (${spells.length}/${level1.prepared})`}
            spells={classSpells.filter((s) => s.level === 1)}
            chosen={spells}
            max={level1.prepared ?? 0}
            onChange={setSpells}
          />
        </>
      )}

      {step === 'Details' && (
        <>
          <label>
            Character name
            <div className="inline-form">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Character name" />
              <button className="button" type="button" onClick={() => setName(randomName())}>Random</button>
            </div>
          </label>
          <label>
            Alignment
            <select value={alignment} onChange={(e) => setAlignment(e.target.value)}>
              <option value="">Not decided</option>
              {rules.alignments.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Languages: Common plus two ({languages.length}/2)</legend>
            <div className="pill-grid">
              {STANDARD_LANGUAGES.map((l) => {
                const on = languages.includes(l);
                return (
                  <button key={l} className={`pill ${on ? 'prof on' : ''}`} disabled={!on && languages.length >= 2} onClick={() => setLanguages(on ? languages.filter((x) => x !== l) : [...languages, l])}>
                    {l}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {(['appearance', 'personality', 'backstory'] as const).map((k) => (
            <label key={k}>
              {k[0].toUpperCase() + k.slice(1)} <span className="hint">(optional)</span>
              <textarea value={details[k]} onChange={(e) => setDetails({ ...details, [k]: e.target.value })} rows={k === 'backstory' ? 4 : 2} />
            </label>
          ))}
        </>
      )}

      {step === 'Review' && (
        <>
          <CharacterSheet character={character} rules={rules} editable={false} onSave={async () => {}} onEdit={() => {}} />
          {error && <p className="error">{error}</p>}
          <button className="button primary block" onClick={save} disabled={busy} data-testid="save-character">
            {busy ? 'Saving…' : 'Save character'}
          </button>
        </>
      )}

      {step !== 'Review' && (
        <footer className="builder-foot">
          {error && <p className="error">{error}</p>}
          <button className="button primary block" disabled={!canContinue[step]} onClick={next} data-testid="builder-next">
            Next
          </button>
        </footer>
      )}
    </div>
  );
}

function blankAssign(): Record<Ability, number | null> {
  return { str: null, dex: null, con: null, int: null, wis: null, cha: null };
}

function skillName(rules: RulesData, index: string) {
  return rules.skills.find((s) => s.index === index)?.name ?? index;
}

function EquipmentChoice({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: EquipmentOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="choice-list">
        {options.map((o) => (
          <button key={o.label} className={`choice ${value === o.label ? 'on' : ''}`} onClick={() => onChange(o.label)}>
            <strong>Option {o.label}</strong>
            <span className="hint">
              {[...o.items.map((i) => (i.qty > 1 ? `${i.qty} ${i.name}` : i.name)), o.gold ? `${o.gold} gp` : ''].filter(Boolean).join(', ')}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function SpellPicker({
  title,
  spells,
  chosen,
  max,
  onChange,
}: {
  title: string;
  spells: RulesData['spells'];
  chosen: string[];
  max: number;
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <fieldset>
      <legend>{title}</legend>
      {spells.map((s) => {
        const on = chosen.includes(s.index);
        return (
          <div key={s.index} className={`spell-pick ${on ? 'on' : ''}`}>
            <div className="row">
              <button className={`pill ${on ? 'prof on' : ''}`} disabled={!on && chosen.length >= max} onClick={() => onChange(on ? chosen.filter((x) => x !== s.index) : [...chosen, s.index])}>
                {s.name}
              </button>
              <span className="hint grow">{s.school}</span>
              <button className="text-button" onClick={() => setOpen(open === s.index ? null : s.index)}>
                {open === s.index ? 'Less' : 'Read'}
              </button>
            </div>
            {open === s.index && (
              <p className="prose hint">
                {s.castingTime} · {s.range} · {s.duration}. {s.description}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
