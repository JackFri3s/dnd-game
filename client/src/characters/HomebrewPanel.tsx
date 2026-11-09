import { useState } from 'react';
import { ABILITIES, ABILITY_NAMES, type Ability, type RulesData } from '../../../shared/rules.ts';
import {
  DAMAGE_TYPES,
  SCHOOLS,
  WEAPON_PROPERTIES,
  checkHomebrew,
  type Homebrew,
  type HomebrewClass,
  type HomebrewItem,
  type HomebrewKind,
  type HomebrewSpecies,
  type HomebrewSpell,
} from '../../../shared/homebrew.ts';
import type { GameStore } from '../game.ts';

const KINDS: { id: HomebrewKind; label: string }[] = [
  { id: 'species', label: 'Species' },
  { id: 'classes', label: 'Classes' },
  { id: 'spells', label: 'Spells' },
  { id: 'items', label: 'Items' },
];

const blank: { [K in HomebrewKind]: () => Homebrew[K][number] } = {
  species: () => ({ id: '', name: '', by: '', byId: '', size: 'Medium', speed: 30, darkvision: 0, resistances: [], traits: [] }),
  classes: () => ({
    id: '', name: '', by: '', byId: '', hitDie: 8, primary: 'str', saves: ['str', 'con'], skillCount: 2, skills: [],
    armor: ['Light'], weapons: ['Simple'], caster: 'none', spellAbility: 'int', spellList: 'wizard', features: [], subclasses: [],
  }),
  spells: () => ({
    id: '', name: '', by: '', byId: '', level: 1, school: 'Evocation', classes: [], castingTime: 'Action', rangeFt: 60, duration: 'Instantaneous',
    concentration: false, ritual: false, damage: '', save: '', attack: '', area: null, description: '',
  }),
  items: () => ({ id: '', name: '', by: '', byId: '', kind: 'weapon', description: '', weapon: { category: 'simple', damage: '1d6', type: 'Slashing', properties: [], ranged: false } }),
};

/** The campaign's custom species, classes, spells and items: list, make, change, delete. */
export function HomebrewPanel({
  store,
  homebrew,
  rules,
  myId,
  isDm,
}: {
  store: GameStore;
  homebrew: Homebrew;
  rules: RulesData;
  myId: string;
  isDm: boolean;
}) {
  const [kind, setKind] = useState<HomebrewKind>('species');
  const [editing, setEditing] = useState<Homebrew[HomebrewKind][number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = homebrew[kind] as { id: string; name: string; by: string; byId: string }[];

  async function save() {
    if (!editing) return;
    const problem = checkHomebrew(kind, editing as unknown as Record<string, unknown>);
    if (problem) return setError(problem);
    try {
      await store.request('homebrew:save', { kind, entry: editing as unknown as Record<string, unknown> });
      setEditing(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="homebrew" data-testid="homebrew">
      <p className="hint">
        Make your own species, classes, spells and items for this campaign. They stay within the rules' limits, and appear in the character builder,
        editor and sheets next to the official ones.
      </p>
      <div className="segmented">
        {KINDS.map((k) => (
          <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => { setKind(k.id); setEditing(null); setError(null); }}>
            {k.label} ({homebrew[k.id].length})
          </button>
        ))}
      </div>

      {!editing && (
        <>
          <ul className="list">
            {list.length === 0 && <li className="hint">Nothing yet.</li>}
            {list.map((e) => (
              <li key={e.id}>
                <div className="grow">
                  <strong>{e.name}</strong>
                  <div className="hint">by {e.by}</div>
                </div>
                {(isDm || e.byId === myId) && (
                  <>
                    <button className="button small" onClick={() => setEditing(structuredClone(e) as Homebrew[HomebrewKind][number])}>Edit</button>
                    <button
                      className="text-button"
                      onClick={() => confirm(`Delete ${e.name}?`) && store.request('homebrew:delete', { kind, entryId: e.id }).catch((err: Error) => setError(err.message))}
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <button className="button block" onClick={() => setEditing(blank[kind]())} data-testid="homebrew-new">
            {{ species: 'New species', classes: 'New class', spells: 'New spell', items: 'New item' }[kind]}
          </button>
        </>
      )}

      {editing && (
        <div className="stack-sm homebrew-form">
          <label>
            Name
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value } as typeof editing)} maxLength={60} aria-label="Custom name" />
          </label>
          {kind === 'species' && <SpeciesForm value={editing as HomebrewSpecies} onChange={setEditing} />}
          {kind === 'classes' && <ClassForm value={editing as HomebrewClass} rules={rules} onChange={setEditing} />}
          {kind === 'spells' && <SpellForm value={editing as HomebrewSpell} rules={rules} onChange={setEditing} />}
          {kind === 'items' && <ItemForm value={editing as HomebrewItem} onChange={setEditing} />}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="button block" onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
            <button className="button primary block" onClick={save} data-testid="homebrew-save">Save</button>
          </div>
        </div>
      )}
      {!editing && error && <p className="error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Texts({ items, onChange, label }: { items: { name: string; description: string }[]; onChange: (v: { name: string; description: string }[]) => void; label: string }) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {items.map((t, i) => (
        <div key={i} className="stack-sm text-entry">
          <div className="inline-form">
            <input value={t.name} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Name" aria-label={`${label} name ${i + 1}`} />
            <button className="text-button" onClick={() => onChange(items.filter((_, j) => j !== i))}>Remove</button>
          </div>
          <textarea value={t.description} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} rows={2} placeholder="What it does" aria-label={`${label} description ${i + 1}`} />
        </div>
      ))}
      <button className="button small" onClick={() => onChange([...items, { name: '', description: '' }])}>Add</button>
    </fieldset>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function SpeciesForm({ value: s, onChange }: { value: HomebrewSpecies; onChange: (v: HomebrewSpecies) => void }) {
  return (
    <>
      <div className="grid-3">
        <label>
          Size
          <select value={s.size} onChange={(e) => onChange({ ...s, size: e.target.value as HomebrewSpecies['size'] })}>
            <option>Small</option>
            <option>Medium</option>
          </select>
        </label>
        <label>
          Speed (20–40 ft)
          <input type="number" step={5} min={20} max={40} value={s.speed} onChange={(e) => onChange({ ...s, speed: Number(e.target.value) })} aria-label="Speed" />
        </label>
        <label>
          Darkvision
          <select value={s.darkvision} onChange={(e) => onChange({ ...s, darkvision: Number(e.target.value) as HomebrewSpecies['darkvision'] })}>
            <option value={0}>None</option>
            <option value={60}>60 ft</option>
            <option value={120}>120 ft</option>
          </select>
        </label>
      </div>
      <div className="label">Damage resistances (at most two)</div>
      <div className="pill-grid">
        {DAMAGE_TYPES.map((d) => (
          <button key={d} className={`pill ${s.resistances.includes(d) ? 'prof on' : ''}`} disabled={!s.resistances.includes(d) && s.resistances.length >= 2} onClick={() => onChange({ ...s, resistances: toggle(s.resistances, d) })}>
            {d}
          </button>
        ))}
      </div>
      <Texts label="Traits (at most six)" items={s.traits} onChange={(traits) => onChange({ ...s, traits })} />
    </>
  );
}

function ClassForm({ value: c, rules, onChange }: { value: HomebrewClass; rules: RulesData; onChange: (v: HomebrewClass) => void }) {
  const abilitySelect = (label: string, v: Ability, set: (a: Ability) => void) => (
    <label>
      {label}
      <select value={v} onChange={(e) => set(e.target.value as Ability)} aria-label={label}>
        {ABILITIES.map((a) => (
          <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="grid-3">
        <label>
          Hit die
          <select value={c.hitDie} onChange={(e) => onChange({ ...c, hitDie: Number(e.target.value) as HomebrewClass['hitDie'] })} aria-label="Hit die">
            {[6, 8, 10, 12].map((d) => (
              <option key={d} value={d}>d{d}</option>
            ))}
          </select>
        </label>
        {abilitySelect('Main ability', c.primary, (primary) => onChange({ ...c, primary }))}
        <label>
          Spellcasting
          <select value={c.caster} onChange={(e) => onChange({ ...c, caster: e.target.value as HomebrewClass['caster'] })} aria-label="Spellcasting">
            <option value="none">None</option>
            <option value="full">Full caster (like a wizard)</option>
            <option value="half">Half caster (like a paladin)</option>
            <option value="pact">Pact magic (like a warlock)</option>
          </select>
        </label>
        {abilitySelect('Saving throw 1', c.saves[0], (a) => onChange({ ...c, saves: [a, c.saves[1]] }))}
        {abilitySelect('Saving throw 2', c.saves[1], (a) => onChange({ ...c, saves: [c.saves[0], a] }))}
        {c.caster !== 'none' && abilitySelect('Spell ability', c.spellAbility, (spellAbility) => onChange({ ...c, spellAbility }))}
        {c.caster !== 'none' && (
          <label>
            Spell list
            <select value={c.spellList ?? 'wizard'} onChange={(e) => onChange({ ...c, spellList: e.target.value })} aria-label="Spell list">
              {rules.classes.filter((x) => x.spellcasting && !x.index.startsWith('hb-')).map((x) => (
                <option key={x.index} value={x.index}>{x.name}'s</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="label">Armour training</div>
      <div className="pill-grid">
        {(['Light', 'Medium', 'Heavy', 'Shields'] as const).map((a) => (
          <button key={a} className={`pill ${c.armor.includes(a) ? 'prof on' : ''}`} onClick={() => onChange({ ...c, armor: toggle(c.armor, a) })}>{a}</button>
        ))}
        {(['Simple', 'Martial'] as const).map((w) => (
          <button key={w} className={`pill ${c.weapons.includes(w) ? 'prof on' : ''}`} onClick={() => onChange({ ...c, weapons: toggle(c.weapons, w) })}>{w} weapons</button>
        ))}
      </div>
      <label>
        Skills to choose (2–4)
        <input type="number" min={2} max={4} value={c.skillCount} onChange={(e) => onChange({ ...c, skillCount: Number(e.target.value) })} aria-label="Skills to choose" />
      </label>
      <div className="pill-grid">
        {rules.skills.map((s) => (
          <button key={s.index} className={`pill ${c.skills.includes(s.index) ? 'prof on' : ''}`} onClick={() => onChange({ ...c, skills: toggle(c.skills, s.index) })}>
            {s.name}
          </button>
        ))}
      </div>
      <fieldset>
        <legend>Features by level</legend>
        <p className="hint">Ability score improvements (levels 4, 8, 12, 16) and the epic boon (19) are added automatically.</p>
        {c.features.map((f, i) => (
          <div key={i} className="stack-sm text-entry">
            <div className="inline-form">
              <input className="qty" type="number" min={1} max={20} value={f.level} onChange={(e) => onChange({ ...c, features: c.features.map((x, j) => (j === i ? { ...x, level: Number(e.target.value) } : x)) })} aria-label={`Feature level ${i + 1}`} />
              <input value={f.name} onChange={(e) => onChange({ ...c, features: c.features.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Feature name" aria-label={`Feature name ${i + 1}`} />
              <button className="text-button" onClick={() => onChange({ ...c, features: c.features.filter((_, j) => j !== i) })}>Remove</button>
            </div>
            <textarea value={f.description} onChange={(e) => onChange({ ...c, features: c.features.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} rows={2} placeholder="What it does" />
          </div>
        ))}
        <button className="button small" onClick={() => onChange({ ...c, features: [...c.features, { level: 1, name: '', description: '' }] })}>Add feature</button>
      </fieldset>
      <label>
        Subclasses (chosen at level 3, separated by commas)
        <input value={c.subclasses.join(', ')} onChange={(e) => onChange({ ...c, subclasses: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      </label>
    </>
  );
}

function SpellForm({ value: s, rules, onChange }: { value: HomebrewSpell; rules: RulesData; onChange: (v: HomebrewSpell) => void }) {
  return (
    <>
      <div className="grid-3">
        <label>
          Level
          <select value={s.level} onChange={(e) => onChange({ ...s, level: Number(e.target.value) })} aria-label="Spell level">
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i} value={i}>{i === 0 ? 'Cantrip' : `Level ${i}`}</option>
            ))}
          </select>
        </label>
        <label>
          School
          <select value={s.school} onChange={(e) => onChange({ ...s, school: e.target.value })}>
            {SCHOOLS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Range (ft; 0 self, 5 touch)
          <input type="number" min={0} max={1000} step={5} value={s.rangeFt} onChange={(e) => onChange({ ...s, rangeFt: Number(e.target.value) })} aria-label="Spell range" />
        </label>
        <label>
          Casting time
          <input value={s.castingTime} onChange={(e) => onChange({ ...s, castingTime: e.target.value })} />
        </label>
        <label>
          Duration
          <input value={s.duration} onChange={(e) => onChange({ ...s, duration: e.target.value })} />
        </label>
        <label>
          Damage (e.g. 3d6 Fire)
          <input value={s.damage} onChange={(e) => onChange({ ...s, damage: e.target.value })} aria-label="Spell damage" />
        </label>
        <label>
          Attack or save
          <select
            value={s.attack ? `atk-${s.attack}` : s.save ? `save-${s.save}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...s, attack: v.startsWith('atk-') ? (v.slice(4) as HomebrewSpell['attack']) : '', save: v.startsWith('save-') ? (v.slice(5) as Ability) : '' });
            }}
            aria-label="Attack or save"
          >
            <option value="">Neither</option>
            <option value="atk-ranged">Ranged spell attack</option>
            <option value="atk-melee">Melee spell attack</option>
            {ABILITIES.map((a) => (
              <option key={a} value={`save-${a}`}>{ABILITY_NAMES[a]} save</option>
            ))}
          </select>
        </label>
        <label>
          Area
          <select
            value={s.area?.shape ?? ''}
            onChange={(e) => onChange({ ...s, area: e.target.value ? { shape: e.target.value as NonNullable<HomebrewSpell['area']>['shape'], size: s.area?.size ?? 20 } : null })}
            aria-label="Area shape"
          >
            <option value="">None</option>
            <option value="sphere">Circle (radius)</option>
            <option value="cone">Cone</option>
            <option value="line">Line</option>
            <option value="cube">Square</option>
            <option value="emanation">Around the caster</option>
          </select>
        </label>
        {s.area && (
          <label>
            Area size (ft)
            <input type="number" min={5} max={120} step={5} value={s.area.size} onChange={(e) => onChange({ ...s, area: { ...s.area!, size: Number(e.target.value) } })} aria-label="Area size" />
          </label>
        )}
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={s.concentration} onChange={(e) => onChange({ ...s, concentration: e.target.checked })} /> Concentration</label>
        <label className="check"><input type="checkbox" checked={s.ritual} onChange={(e) => onChange({ ...s, ritual: e.target.checked })} /> Ritual</label>
      </div>
      <div className="label">Which classes can learn it</div>
      <div className="pill-grid">
        {rules.classes.filter((c) => c.spellcasting).map((c) => (
          <button key={c.index} className={`pill ${s.classes.includes(c.index) ? 'prof on' : ''}`} onClick={() => onChange({ ...s, classes: toggle(s.classes, c.index) })}>
            {c.name}
          </button>
        ))}
      </div>
      <label>
        Description
        <textarea value={s.description} onChange={(e) => onChange({ ...s, description: e.target.value })} rows={4} aria-label="Spell description" />
      </label>
    </>
  );
}

function ItemForm({ value: it, onChange }: { value: HomebrewItem; onChange: (v: HomebrewItem) => void }) {
  const w = it.weapon ?? { category: 'simple' as const, damage: '1d6', type: 'Slashing', properties: [], ranged: false };
  const a = it.armor ?? { category: 'light' as const, base: 11 };
  return (
    <>
      <div className="segmented">
        {(['weapon', 'armor', 'shield', 'gear'] as const).map((k) => (
          <button key={k} className={it.kind === k ? 'on' : ''} onClick={() => onChange({ ...it, kind: k, ...(k === 'weapon' ? { weapon: w } : {}), ...(k === 'armor' ? { armor: a } : {}) })}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {it.kind === 'weapon' && (
        <>
          <div className="grid-3">
            <label>
              Damage (e.g. 1d8)
              <input value={w.damage} onChange={(e) => onChange({ ...it, weapon: { ...w, damage: e.target.value } })} aria-label="Weapon damage" />
            </label>
            <label>
              Damage type
              <select value={w.type} onChange={(e) => onChange({ ...it, weapon: { ...w, type: e.target.value } })}>
                {DAMAGE_TYPES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label>
              Category
              <select value={w.category} onChange={(e) => onChange({ ...it, weapon: { ...w, category: e.target.value as 'simple' | 'martial' } })}>
                <option value="simple">Simple</option>
                <option value="martial">Martial</option>
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" checked={w.ranged} onChange={(e) => onChange({ ...it, weapon: { ...w, ranged: e.target.checked } })} /> Ranged weapon</label>
          {(w.ranged || w.properties.includes('Thrown')) && (
            <div className="grid-2">
              <label>Normal range (ft)<input type="number" value={w.normal ?? 20} onChange={(e) => onChange({ ...it, weapon: { ...w, normal: Number(e.target.value) } })} /></label>
              <label>Long range (ft)<input type="number" value={w.long ?? 60} onChange={(e) => onChange({ ...it, weapon: { ...w, long: Number(e.target.value) } })} /></label>
            </div>
          )}
          <div className="pill-grid">
            {WEAPON_PROPERTIES.map((p) => (
              <button key={p} className={`pill ${w.properties.includes(p) ? 'prof on' : ''}`} onClick={() => onChange({ ...it, weapon: { ...w, properties: toggle(w.properties, p) } })}>{p}</button>
            ))}
          </div>
        </>
      )}
      {it.kind === 'armor' && (
        <div className="grid-2">
          <label>
            Category
            <select value={a.category} onChange={(e) => onChange({ ...it, armor: { ...a, category: e.target.value as 'light' | 'medium' | 'heavy' } })}>
              <option value="light">Light (AC 11–12 + Dex)</option>
              <option value="medium">Medium (AC 12–15 + Dex, max 2)</option>
              <option value="heavy">Heavy (AC 14–18)</option>
            </select>
          </label>
          <label>
            Base armour class
            <input type="number" value={a.base} onChange={(e) => onChange({ ...it, armor: { ...a, base: Number(e.target.value) } })} aria-label="Base armour class" />
          </label>
        </div>
      )}
      <label>
        Description
        <textarea value={it.description} onChange={(e) => onChange({ ...it, description: e.target.value })} rows={3} />
      </label>
    </>
  );
}
