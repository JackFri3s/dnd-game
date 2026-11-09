import { useState } from 'react';
import {
  ABILITIES,
  ABILITY_NAMES,
  averageHp,
  derive,
  emptyCharacter,
  maxPossibleHp,
  mod,
  signed,
  withSummary,
  type Character,
  type RulesData,
} from '../../../shared/rules.ts';
import { randomName } from '../rules/index.ts';

interface Props {
  rules: RulesData;
  initial?: Character;
  onSave: (c: Character) => Promise<unknown>;
  onCancel: () => void;
  onDelete?: () => void;
}

/**
 * Enter an existing character (e.g. from a paper sheet), or edit any character.
 * The app works out the numbers and warns about anything that doesn't add up,
 * but never blocks: the table's word goes.
 */
export function CharacterEditor({ rules, initial, onSave, onCancel, onDelete }: Props) {
  const [c, setC] = useState<Character>(() => initial ?? { ...emptyCharacter(), createdWith: 'manual', abilityMethod: 'manual' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemQuery, setItemQuery] = useState('');
  const [spellQuery, setSpellQuery] = useState('');
  const set = (patch: Partial<Character>) => setC((prev) => ({ ...prev, ...patch }));

  const cls = rules.classes.find((x) => x.index === c.classIndex);
  const species = rules.species.find((x) => x.index === c.speciesIndex);
  const d = c.classIndex ? derive(c, rules) : null;
  const conMod = mod(c.abilities.con);

  // ---- warnings: things that probably aren't right (but are allowed) ----
  const warnings: string[] = [];
  if (cls) {
    if (c.hp.max > maxPossibleHp(cls.hitDie, c.level, conMod))
      warnings.push(`${c.hp.max} hit points is more than a level ${c.level} ${cls.name} can have (at most ${maxPossibleHp(cls.hitDie, c.level, conMod)}).`);
    const expectedSkills = cls.skillChoice.choose + (rules.backgrounds.find((b) => b.index === c.backgroundIndex)?.skills.length ?? 2);
    if (c.skills.length > expectedSkills + 2) warnings.push(`${c.skills.length} skill proficiencies is more than usual (about ${expectedSkills}).`);
    const row = cls.levels.find((l) => l.level === c.level);
    if (row?.cantrips !== undefined && c.cantrips.length > row.cantrips) warnings.push(`A level ${c.level} ${cls.name} usually knows ${row.cantrips} cantrips, not ${c.cantrips.length}.`);
    if (row?.prepared !== undefined && c.spells.length > row.prepared) warnings.push(`A level ${c.level} ${cls.name} usually prepares ${row.prepared} spells, not ${c.spells.length}.`);
    if (!cls.spellcasting && c.spells.length + c.cantrips.length > 0) warnings.push(`${cls.name}s don't cast spells (unless a feat or species gives them some).`);
  }
  for (const a of ABILITIES) if (c.abilities[a] > 20) warnings.push(`${ABILITY_NAMES[a]} ${c.abilities[a]} is above the normal maximum of 20.`);

  async function save() {
    if (!c.name.trim()) return setError('Give your character a name.');
    if (!c.classIndex || !c.speciesIndex) return setError('Choose a class and a species.');
    setBusy(true);
    setError(null);
    try {
      await onSave(withSummary({ ...c, name: c.name.trim(), hp: { ...c.hp, current: Math.min(c.hp.current, c.hp.max) } }, rules));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, parseInt(v, 10) || 0));
  const itemMatches = itemQuery.length >= 2 ? rules.items.filter((i) => i.name.toLowerCase().includes(itemQuery.toLowerCase())).slice(0, 6) : [];
  const spellMatches =
    spellQuery.length >= 2
      ? rules.spells.filter((s) => s.name.toLowerCase().includes(spellQuery.toLowerCase()) && !c.spells.includes(s.index) && !c.cantrips.includes(s.index)).slice(0, 6)
      : [];

  return (
    <div className="editor" data-testid="editor">
      <header className="builder-head">
        <button className="text-button" onClick={onCancel}>← Cancel</button>
        <span className="hint">{initial ? 'Edit character' : 'Enter an existing character'}</span>
      </header>

      <label>
        Name
        <div className="inline-form">
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} maxLength={40} aria-label="Name" />
          <button type="button" className="button" onClick={() => set({ name: randomName() })}>Random</button>
        </div>
      </label>

      <div className="grid-2">
        <label>
          Class
          <select value={c.classIndex} onChange={(e) => set({ classIndex: e.target.value, subclassIndex: null })} aria-label="Class">
            <option value="">Choose…</option>
            {rules.classes.map((x) => (
              <option key={x.index} value={x.index}>{x.name}</option>
            ))}
          </select>
        </label>
        <label>
          Level
          <input type="number" min={1} max={20} value={c.level} onChange={(e) => set({ level: num(e.target.value, 1, 20) })} aria-label="Level" />
        </label>
        <label>
          Species
          <select value={c.speciesIndex} onChange={(e) => set({ speciesIndex: e.target.value, subspeciesIndex: null })} aria-label="Species">
            <option value="">Choose…</option>
            {rules.species.map((x) => (
              <option key={x.index} value={x.index}>{x.name}</option>
            ))}
          </select>
        </label>
        {species && species.subspecies.length > 0 ? (
          <label>
            {species.subspecies[0].name.split(':')[0]}
            <select value={c.subspeciesIndex ?? ''} onChange={(e) => set({ subspeciesIndex: e.target.value || null })}>
              <option value="">–</option>
              {species.subspecies.map((x) => (
                <option key={x.index} value={x.index}>{x.name.replace(/^.*?: /, '')}</option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        <label>
          Background
          <select value={c.backgroundIndex} onChange={(e) => set({ backgroundIndex: e.target.value })}>
            <option value="">Other / not listed</option>
            {rules.backgrounds.map((x) => (
              <option key={x.index} value={x.index}>{x.name}</option>
            ))}
          </select>
        </label>
        {cls && cls.subclasses.length > 0 && c.level >= 3 ? (
          <label>
            Subclass
            <select value={c.subclassIndex ?? ''} onChange={(e) => set({ subclassIndex: e.target.value || null })}>
              <option value="">Other / not listed</option>
              {cls.subclasses.map((x) => (
                <option key={x.index} value={x.index}>{x.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
      </div>

      <h3>Ability scores</h3>
      <div className="grid-3">
        {ABILITIES.map((a) => (
          <label key={a}>
            {ABILITY_NAMES[a]} <span className="hint">{signed(mod(c.abilities[a]))}</span>
            <input type="number" min={1} max={30} value={c.abilities[a]} onChange={(e) => set({ abilities: { ...c.abilities, [a]: num(e.target.value, 1, 30) } })} aria-label={ABILITY_NAMES[a]} />
          </label>
        ))}
      </div>

      <h3>Hit points and defence</h3>
      <div className="grid-3">
        <label>
          Max HP
          <input type="number" min={1} value={c.hp.max} onChange={(e) => set({ hp: { ...c.hp, max: num(e.target.value, 1, 999), current: num(e.target.value, 1, 999) } })} aria-label="Max HP" />
        </label>
        <label>
          Armour class <span className="hint">({d ? 'calculated ' + (c.overrides.ac === undefined ? d.ac : '–') : ''})</span>
          <input
            type="number"
            placeholder="auto"
            value={c.overrides.ac ?? ''}
            onChange={(e) => set({ overrides: { ...c.overrides, ac: e.target.value === '' ? undefined : num(e.target.value, 0, 40) } })}
            aria-label="Armour class"
          />
        </label>
        <label>
          Speed (ft)
          <input
            type="number"
            placeholder={String(species?.speed ?? 30)}
            value={c.overrides.speed ?? ''}
            onChange={(e) => set({ overrides: { ...c.overrides, speed: e.target.value === '' ? undefined : num(e.target.value, 0, 300) } })}
            aria-label="Speed"
          />
        </label>
      </div>
      {cls && (
        <p className="hint">
          Average for a level {c.level} {cls.name}: {averageHp(cls.hitDie, c.level, conMod)} HP.{' '}
          <button className="text-button" onClick={() => { const hp = averageHp(cls.hitDie, c.level, conMod); set({ hp: { ...c.hp, max: hp, current: hp } }); }}>
            Use average
          </button>
        </p>
      )}

      <h3>Skill proficiencies</h3>
      <div className="pill-grid">
        {rules.skills.map((s) => {
          const on = c.skills.includes(s.index);
          return (
            <button key={s.index} className={`pill ${on ? 'prof on' : ''}`} onClick={() => set({ skills: on ? c.skills.filter((x) => x !== s.index) : [...c.skills, s.index] })}>
              {s.name}
            </button>
          );
        })}
      </div>

      <h3>Equipment</h3>
      <ul className="list compact">
        {c.items.map((it, i) => (
          <li key={i}>
            <input className="qty" type="number" min={0} value={it.qty} onChange={(e) => set({ items: c.items.map((x, j) => (j === i ? { ...x, qty: num(e.target.value, 0, 9999) } : x)) })} aria-label={`${it.name} quantity`} />
            <span className="grow">{it.name}</span>
            <button className="text-button" onClick={() => set({ items: c.items.filter((_, j) => j !== i) })}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="inline-form">
        <input value={itemQuery} onChange={(e) => setItemQuery(e.target.value)} placeholder="Add an item (search, or type your own)" aria-label="Add item" />
        <button className="button" disabled={!itemQuery.trim()} onClick={() => { set({ items: [...c.items, { index: null, name: itemQuery.trim(), qty: 1 }] }); setItemQuery(''); }}>
          Add
        </button>
      </div>
      {itemMatches.length > 0 && (
        <div className="chip-row">
          {itemMatches.map((i) => (
            <button key={i.index} className="chip" onClick={() => { set({ items: [...c.items, { index: i.index, name: i.name, qty: 1, ...(i.kind === 'armor' || i.kind === 'shield' ? { equipped: true } : {}) }] }); setItemQuery(''); }}>
              + {i.name}
            </button>
          ))}
        </div>
      )}
      <label>
        Gold
        <input type="number" min={0} value={c.gold} onChange={(e) => set({ gold: num(e.target.value, 0, 10_000_000) })} aria-label="Gold" />
      </label>

      <h3>Spells</h3>
      <ul className="list compact">
        {[...c.cantrips, ...c.spells].map((id) => {
          const s = rules.spells.find((x) => x.index === id);
          return (
            <li key={id}>
              <span className="grow">{s?.name ?? id}</span>
              <span className="hint">{s?.level ? `Level ${s.level}` : 'Cantrip'}</span>
              <button className="text-button" onClick={() => set({ cantrips: c.cantrips.filter((x) => x !== id), spells: c.spells.filter((x) => x !== id) })}>Remove</button>
            </li>
          );
        })}
      </ul>
      <input value={spellQuery} onChange={(e) => setSpellQuery(e.target.value)} placeholder="Add a spell (search)" aria-label="Add spell" />
      {spellMatches.length > 0 && (
        <div className="chip-row">
          {spellMatches.map((s) => (
            <button key={s.index} className="chip" onClick={() => { set(s.level === 0 ? { cantrips: [...c.cantrips, s.index] } : { spells: [...c.spells, s.index] }); setSpellQuery(''); }}>
              + {s.name} <span className="hint">{s.level ? `L${s.level}` : 'cantrip'}</span>
            </button>
          ))}
        </div>
      )}

      <h3>About</h3>
      <label>
        Languages <span className="hint">(separated by commas)</span>
        <input value={c.languages.join(', ')} onChange={(e) => set({ languages: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </label>
      <label>
        Alignment
        <select value={c.alignment} onChange={(e) => set({ alignment: e.target.value })}>
          <option value="">Not decided</option>
          {rules.alignments.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      {(['appearance', 'personality', 'ideals', 'bonds', 'flaws', 'backstory'] as const).map((k) => (
        <label key={k}>
          {k[0].toUpperCase() + k.slice(1)}
          <textarea value={c.details[k]} onChange={(e) => set({ details: { ...c.details, [k]: e.target.value } })} rows={k === 'backstory' ? 4 : 2} />
        </label>
      ))}

      {warnings.length > 0 && (
        <div className="warnings" data-testid="warnings">
          <strong>Check these</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="hint">You can still save: the Dungeon Master decides.</p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button className="button primary block" onClick={save} disabled={busy} data-testid="save-character">
        {busy ? 'Saving…' : 'Save character'}
      </button>
      {onDelete && (
        <button className="text-button" onClick={onDelete}>
          Delete this character
        </button>
      )}
    </div>
  );
}
