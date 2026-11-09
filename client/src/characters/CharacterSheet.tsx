import { useState } from 'react';
import {
  ABILITIES,
  ABILITY_NAMES,
  derive,
  emptyCharacter,
  signed,
  withSummary,
  type Ability,
  type Character,
  type RulesData,
} from '../../../shared/rules.ts';
import { formatDistance, useSettings } from '../settings.ts';

interface Props {
  character: Character;
  rules: RulesData;
  editable: boolean;
  onSave: (c: Character) => Promise<unknown>;
  onEdit: () => void;
  /** Roll dice through the game (shown on the Main Screen). */
  onRoll?: (label: string, modifier: number, dice?: { count: number; sides: number }[]) => void;
}

/** Characters saved by older versions miss some fields: fill them in. */
export function normalizeCharacter(c: Character): Character {
  const base = emptyCharacter();
  return { ...base, ...c, deathSaves: { ...base.deathSaves, ...c.deathSaves }, trackers: c.trackers ?? [], overrides: c.overrides ?? {} };
}

/** "2d6+3 Slashing" -> dice and modifier to roll. */
function parseDamage(text: string) {
  const dice = [...text.matchAll(/(\d+)d(\d+)/g)].map((m) => ({ count: Number(m[1]), sides: Number(m[2]) }));
  const mod = text.match(/d\d+\s*([+-−]\s*\d+)/);
  return { dice, modifier: mod ? Number(mod[1].replace('−', '-').replace(/\s/g, '')) : 0 };
}

/**
 * A character sheet laid out like the official 2024 sheet: who they are at the
 * top, then defences, then abilities with their saves and skills, attacks,
 * spells and features. Everything is worked out from the rules.
 */
export function CharacterSheet({ character, rules, editable, onSave, onEdit, onRoll }: Props) {
  const c = normalizeCharacter(character);
  const { unit } = useSettings();
  const d = derive(c, rules);
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [newTracker, setNewTracker] = useState({ name: '', max: '1' });
  const save = (next: Character) => (editable ? onSave(withSummary(next, rules)) : Promise.resolve());
  const roll = (label: string, mod: number, dice?: { count: number; sides: number }[]) => onRoll?.(`${c.name}: ${label}`, mod, dice);
  const toggle = (key: string) => setOpen(open === key ? null : key);

  const background = rules.backgrounds.find((b) => b.index === c.backgroundIndex);
  const subclass = d.cls?.subclasses.find((s) => s.index === c.subclassIndex);
  const subspecies = d.species?.subspecies.find((s) => s.index === c.subspeciesIndex);
  const shield = c.items.some((i) => i.equipped && rules.items.find((r) => r.index === i.index)?.kind === 'shield');

  // ---- hit points ----
  function changeHp(kind: 'damage' | 'heal' | 'temp') {
    const n = Math.abs(parseInt(amount, 10));
    if (!n) return;
    let { current, temp } = c.hp;
    if (kind === 'damage') {
      const fromTemp = Math.min(temp, n);
      temp -= fromTemp;
      current = Math.max(0, current - (n - fromTemp));
    } else if (kind === 'heal') current = Math.min(c.hp.max, Math.max(0, current) + n);
    else temp = Math.max(temp, n); // temporary hit points don't stack
    const deathSaves = current > 0 ? { successes: 0, failures: 0 } : c.deathSaves;
    save({ ...c, hp: { ...c.hp, current, temp }, deathSaves });
    setAmount('');
  }

  // ---- table of weapons and damaging spells ----
  const spellRows = [...c.cantrips, ...c.spells]
    .map((id) => rules.spells.find((s) => s.index === id))
    .filter((s): s is NonNullable<typeof s> => !!s && !!(s.damage || s.attack));
  const armor = d.cls?.proficiencies ?? [];
  const has = (name: string) => armor.some((p) => p.toLowerCase().includes(name));
  const traitIndexes = [...(d.species?.traits ?? []), ...(subspecies?.traits ?? [])];
  const traits = traitIndexes.map((t) => rules.traits.find((x) => x.index === t)).filter((t): t is NonNullable<typeof t> => !!t);
  const features = rules.features.filter((f) => f.class === c.classIndex && f.level <= c.level && !/subclass$/.test(f.index));
  const feats = c.feats.map((f) => rules.feats.find((x) => x.index === f)).filter((f): f is NonNullable<typeof f> => !!f);
  const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

  return (
    <div className="sheet" data-testid="character-sheet">
      {/* ---------- who ---------- */}
      <section className="box sheet-header">
        <div className="row top">
          <div className="grow">
            <div className="field-label">Character name</div>
            <h2 className="char-name">{c.name}</h2>
          </div>
          <div className="level-xp">
            <div className="field-label">Level</div>
            <div className="circle">{c.level}</div>
          </div>
          <div className="level-xp">
            <div className="field-label">XP</div>
            <div className="small-box">{c.xp}</div>
          </div>
          {editable && (
            <button className="icon-button" onClick={onEdit} aria-label="Edit character" title="Edit">
              ✎
            </button>
          )}
        </div>
        <div className="field-grid">
          <Field label="Background" value={background?.name ?? '–'} />
          <Field label="Class" value={d.cls?.name ?? c.classIndex} />
          <Field label="Species" value={[d.species?.name, subspecies ? `(${subspecies.name.replace(/^.*?: /, '')})` : ''].filter(Boolean).join(' ')} />
          <Field label="Subclass" value={subclass?.name ?? '–'} />
        </div>
      </section>

      {/* ---------- defences ---------- */}
      <div className="sheet-grid-2">
        <section className="box center">
          <div className="field-label">Armour class</div>
          <div className="big-number" data-testid="ac">{d.ac}</div>
          <div className={`tick ${shield ? 'on' : ''}`}>
            <span className="diamond" /> Shield
          </div>
        </section>
        <section className="box hp-box">
          <div className="hp-main">
            <div className="field-label">Hit points</div>
            <div className="hp" data-testid="hp">
              <strong>{c.hp.current}</strong>
              {c.hp.temp > 0 && <span className="hint"> (+{c.hp.temp} temp)</span>}
            </div>
            {editable && (
              <div className="hp-edit">
                <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="0" aria-label="Amount" />
                <button className="button small" onClick={() => changeHp('damage')}>Damage</button>
                <button className="button small" onClick={() => changeHp('heal')}>Heal</button>
                <button className="button small" onClick={() => changeHp('temp')}>Temp</button>
              </div>
            )}
          </div>
          <div className="hp-side">
            <div className="field-label">Temp</div>
            <div>{c.hp.temp}</div>
            <div className="field-label">Max</div>
            <div>{c.hp.max}</div>
          </div>
        </section>
        <section className="box">
          <div className="field-label center">Hit dice</div>
          <div className="kv"><span>Available</span><strong>{Math.max(0, c.level - c.hitDiceSpent)}</strong></div>
          <div className="kv"><span>Spent</span><strong>{c.hitDiceSpent}</strong></div>
          <div className="kv"><span>Max</span><strong>{c.level}d{d.cls?.hitDie ?? 8}</strong></div>
          {editable && (
            <div className="row-buttons">
              <button
                className="text-button"
                disabled={c.hitDiceSpent >= c.level}
                onClick={() => {
                  roll('Hit die', d.mods.con, [{ count: 1, sides: d.cls?.hitDie ?? 8 }]);
                  save({ ...c, hitDiceSpent: c.hitDiceSpent + 1 });
                }}
              >
                Spend one (roll)
              </button>
              {c.hitDiceSpent > 0 && <button className="text-button" onClick={() => save({ ...c, hitDiceSpent: 0 })}>Long rest</button>}
            </div>
          )}
        </section>
        <section className="box">
          <div className="field-label center">Death saves</div>
          {(['successes', 'failures'] as const).map((k) => (
            <div key={k} className="death-row">
              <span className="diamonds">
                {[0, 1, 2].map((i) => (
                  <button
                    key={i}
                    className={`diamond ${i < c.deathSaves[k] ? 'on' : ''} ${k}`}
                    disabled={!editable}
                    onClick={() => save({ ...c, deathSaves: { ...c.deathSaves, [k]: i < c.deathSaves[k] ? i : i + 1 } })}
                    aria-label={`${k} ${i + 1}`}
                  />
                ))}
              </span>
              <span className="field-label">{k}</span>
            </div>
          ))}
          {onRoll && c.hp.current <= 0 && (
            <button className="text-button" onClick={() => roll('Death saving throw', 0)}>Roll a death save</button>
          )}
        </section>
      </div>

      {/* ---------- the strip ---------- */}
      <section className="stat-strip">
        <Stat label="Proficiency bonus" value={signed(d.prof)} />
        <button className={`stat inspiration ${c.inspiration ? 'on' : ''}`} disabled={!editable} onClick={() => save({ ...c, inspiration: !c.inspiration })}>
          <span className="diamond big" />
          <span className="field-label">Heroic inspiration</span>
        </button>
        <Stat label="Initiative" value={signed(d.initiative)} onClick={onRoll && (() => roll('Initiative', d.initiative))} />
        <Stat label="Speed" value={formatDistance(d.speedFt, unit)} />
        <Stat label="Size" value={d.species?.size.split(' ')[0] ?? '–'} />
        <Stat label="Passive perception" value={d.passivePerception} />
      </section>
      {onRoll && <p className="hint center">Tap a number to roll it. Rolls show on the Main Screen.</p>}

      <div className="sheet-columns">
        {/* ---------- abilities, each with its save and skills ---------- */}
        <section className="ability-blocks">
          {ABILITIES.map((a: Ability) => {
            const skills = d.skills.filter((s) => s.ability === a);
            const saveProf = d.cls?.saves.includes(a);
            return (
              <div key={a} className="box ability-block">
                <div className="field-label center">{ABILITY_NAMES[a]}</div>
                <div className="ability-top">
                  <button className="mod-circle" onClick={() => roll(`${ABILITY_NAMES[a]} check`, d.mods[a])} disabled={!onRoll} aria-label={`${ABILITY_NAMES[a]} check`}>
                    {signed(d.mods[a])}
                  </button>
                  <div className="score-box">
                    {c.abilities[a]}
                    <span className="field-label">Score</span>
                  </div>
                </div>
                <button className="skill-row save" onClick={() => roll(`${ABILITY_NAMES[a]} save`, d.saves[a])} disabled={!onRoll}>
                  <span className={`prof-dot ${saveProf ? "on" : ""}`} />
                  <strong>{signed(d.saves[a])}</strong> Saving throw
                </button>
                {skills.map((s) => (
                  <button key={s.index} className="skill-row" onClick={() => roll(s.name, s.bonus)} disabled={!onRoll}>
                    <span className={`prof-dot ${s.proficient ? "on" : ""}`} />
                    <strong>{signed(s.bonus)}</strong> {s.name}
                  </button>
                ))}
              </div>
            );
          })}
        </section>

        <div className="sheet-main">
          {/* ---------- weapons, cantrips and damage ---------- */}
          <section className="box">
            <div className="field-label center">Weapons, cantrips &amp; damage</div>
            <table className="attack-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Atk / DC</th>
                  <th>Damage &amp; type</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {d.attacks.map((w, i) => (
                  <tr key={`w${i}`}>
                    <td>{w.name}</td>
                    <td>
                      <button className="roll-chip" onClick={() => roll(`${w.name} attack`, w.toHit)} disabled={!onRoll}>{signed(w.toHit)}</button>
                    </td>
                    <td>
                      <button
                        className="roll-chip"
                        disabled={!onRoll}
                        onClick={() => {
                          const p = parseDamage(w.damage);
                          roll(`${w.name} damage`, p.modifier, p.dice);
                        }}
                      >
                        {w.damage}
                      </button>
                    </td>
                    <td className="hint">{w.range}</td>
                  </tr>
                ))}
                {spellRows.map((s) => (
                  <tr key={s.index}>
                    <td>{s.name}</td>
                    <td>
                      {s.attack && d.spellcasting ? (
                        <button className="roll-chip" onClick={() => roll(`${s.name} attack`, d.spellcasting!.attack)} disabled={!onRoll}>
                          {signed(d.spellcasting.attack)}
                        </button>
                      ) : s.save && d.spellcasting ? (
                        <span>DC {d.spellcasting.saveDc} {s.save.toUpperCase()}</span>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td>
                      {s.damage ? (
                        <button
                          className="roll-chip"
                          disabled={!onRoll}
                          onClick={() => {
                            const p = parseDamage(s.damage!);
                            roll(`${s.name} damage`, 0, p.dice);
                          }}
                        >
                          {s.damage}
                        </button>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="hint">{s.level === 0 ? 'Cantrip' : `Level ${s.level}`}</td>
                  </tr>
                ))}
                {d.attacks.length + spellRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="hint">No weapons or damaging spells.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* ---------- limited-use features ---------- */}
          <section className="box">
            <div className="field-label center">Limited-use features</div>
            {c.trackers.map((t, i) => (
              <div key={i} className="tracker">
                <span className="grow">{t.name}</span>
                <span className="diamonds">
                  {Array.from({ length: t.max }, (_, j) => (
                    <button
                      key={j}
                      className={`diamond ${j < t.used ? 'on' : ''}`}
                      disabled={!editable}
                      onClick={() => save({ ...c, trackers: c.trackers.map((x, k) => (k === i ? { ...x, used: j < x.used ? j : j + 1 } : x)) })}
                      aria-label={`${t.name} use ${j + 1}`}
                    />
                  ))}
                </span>
                {editable && (
                  <button className="text-button" onClick={() => save({ ...c, trackers: c.trackers.filter((_, k) => k !== i) })} aria-label={`Remove ${t.name}`}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <form
                className="inline-form tracker-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newTracker.name.trim()) return;
                  save({ ...c, trackers: [...c.trackers, { name: newTracker.name.trim(), max: Math.max(1, Math.min(20, Number(newTracker.max) || 1)), used: 0 }] });
                  setNewTracker({ name: '', max: '1' });
                }}
              >
                <input value={newTracker.name} onChange={(e) => setNewTracker({ ...newTracker, name: e.target.value })} placeholder="e.g. Second Wind" aria-label="Feature name" />
                <input className="qty" type="number" min={1} max={20} value={newTracker.max} onChange={(e) => setNewTracker({ ...newTracker, max: e.target.value })} aria-label="Uses" />
                <button className="button small">Add</button>
              </form>
            )}
          </section>

          {/* ---------- spellcasting ---------- */}
          {d.spellcasting && (
            <section className="box">
              <div className="field-label center">Spellcasting</div>
              <div className="spell-stats">
                <Stat label="Ability" value={d.spellcasting.ability.toUpperCase()} />
                <Stat label="Save DC" value={d.spellcasting.saveDc} />
                <Stat label="Attack bonus" value={signed(d.spellcasting.attack)} />
              </div>
              {d.spellcasting.slots.some((n) => n > 0) && (
                <div className="slots">
                  {d.spellcasting.slots.map((count, lvl) =>
                    count > 0 ? (
                      <div key={lvl} className="slot-row">
                        <span className="field-label">Level {lvl + 1}</span>
                        <span className="diamonds">
                          {Array.from({ length: count }, (_, i) => (
                            <button
                              key={i}
                              className={`diamond spell-slot ${i < c.spellSlotsUsed[lvl] ? 'on' : ''}`}
                              disabled={!editable}
                              onClick={() => {
                                const used = [...c.spellSlotsUsed];
                                used[lvl] = i < used[lvl] ? i : i + 1;
                                save({ ...c, spellSlotsUsed: used });
                              }}
                              aria-label={`Level ${lvl + 1} slot ${i + 1}${i < c.spellSlotsUsed[lvl] ? ' (used)' : ''}`}
                            />
                          ))}
                        </span>
                      </div>
                    ) : null,
                  )}
                  {editable && c.spellSlotsUsed.some((n) => n > 0) && (
                    <button className="text-button" onClick={() => save({ ...c, spellSlotsUsed: c.spellSlotsUsed.map(() => 0) })}>Long rest: regain all slots</button>
                  )}
                </div>
              )}
              {[...c.cantrips, ...c.spells]
                .map((id) => rules.spells.find((x) => x.index === id))
                .filter((s): s is NonNullable<typeof s> => !!s)
                .map((s) => (
                  <Expandable key={s.index} title={s.name} meta={s.level === 0 ? 'Cantrip' : `Level ${s.level}`} open={open === s.index} onToggle={() => toggle(s.index)}>
                    <p className="hint">
                      {s.castingTime} · {s.range} · {s.duration}
                      {s.concentration ? ' · concentration' : ''}
                    </p>
                    <p className="prose">{s.description}</p>
                  </Expandable>
                ))}
            </section>
          )}

          {/* ---------- features ---------- */}
          <section className="box">
            <div className="field-label center">Class features</div>
            {features.map((f) => (
              <Expandable key={f.index} title={f.name} meta={`${d.cls?.name} ${f.level}`} open={open === f.index} onToggle={() => toggle(f.index)} preview={firstSentence(f.description)}>
                <p className="prose">{f.description}</p>
              </Expandable>
            ))}
          </section>
          <div className="sheet-grid-2">
            <section className="box">
              <div className="field-label center">Species traits</div>
              {traits.map((t) => (
                <Expandable key={t.index} title={t.name} meta="" open={open === t.index} onToggle={() => toggle(t.index)} preview={firstSentence(t.description)}>
                  <p className="prose">{t.description}</p>
                </Expandable>
              ))}
            </section>
            <section className="box">
              <div className="field-label center">Feats</div>
              {feats.map((f) => (
                <Expandable key={f.index} title={f.name} meta="" open={open === f.index} onToggle={() => toggle(f.index)} preview={firstSentence(f.description)}>
                  <p className="prose">{f.description}</p>
                </Expandable>
              ))}
              {feats.length === 0 && <p className="hint">–</p>}
            </section>
          </div>

          {/* ---------- training, equipment ---------- */}
          <section className="box">
            <div className="field-label center">Equipment training &amp; proficiencies</div>
            <div className="training">
              <span className="field-label">Armour training</span>
              {['Light', 'Medium', 'Heavy', 'Shields'].map((a) => (
                <span key={a} className={`tick ${has(a.toLowerCase() === 'shields' ? 'shield' : a.toLowerCase() + ' armor') || (a !== 'Shields' && has('all armor')) ? 'on' : ''}`}>
                  <span className="diamond" /> {a}
                </span>
              ))}
            </div>
            <Field label="Weapons" value={armor.filter((p) => /weapon|sword|bow|crossbow|dagger|dart|sling|staff|club|mace|spear|axe|hammer|whip|scimitar|rapier/i.test(p)).join(', ') || '–'} />
            <Field label="Tools" value={background?.tools.join(', ') || '–'} />
            <Field label="Languages" value={c.languages.join(', ') || '–'} />
          </section>

          <section className="box">
            <div className="field-label center">Equipment</div>
            <ul className="list compact">
              {c.items.map((it, i) => {
                const r = it.index ? rules.items.find((x) => x.index === it.index) : undefined;
                const wearable = r && (r.kind === 'armor' || r.kind === 'shield');
                return (
                  <li key={i}>
                    <span className="grow">
                      {it.qty > 1 ? `${it.qty} × ` : ''}
                      {it.name}
                    </span>
                    {wearable &&
                      (editable ? (
                        <button
                          className={`chip ${it.equipped ? 'on' : ''}`}
                          onClick={() => save({ ...c, items: c.items.map((x, k) => (k === i ? { ...x, equipped: !x.equipped } : x)) })}
                        >
                          {it.equipped ? 'Worn' : 'Wear'}
                        </button>
                      ) : (
                        it.equipped && <span className="hint">worn</span>
                      ))}
                  </li>
                );
              })}
              <li>
                <span className="grow">Coins</span>
                <strong>{c.gold} GP</strong>
              </li>
            </ul>
          </section>

          {Object.values(c.details).some(Boolean) && (
            <section className="box">
              <div className="field-label center">Appearance, personality &amp; backstory</div>
              {(['appearance', 'personality', 'ideals', 'bonds', 'flaws', 'backstory'] as const).map((k) =>
                c.details[k] ? (
                  <div key={k} className="detail">
                    <div className="field-label">{k}</div>
                    <p className="prose">{c.details[k]}</p>
                  </div>
                ) : null,
              )}
              {c.alignment && <Field label="Alignment" value={c.alignment} />}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{value}</div>
    </div>
  );
}

function Stat({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }) {
  return (
    <button className="stat" onClick={onClick} disabled={!onClick}>
      <span className="field-label">{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

function Expandable({
  title,
  meta,
  open,
  onToggle,
  preview,
  children,
}: {
  title: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  preview?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`expandable ${open ? 'open' : ''}`}>
      <button className="expandable-head" onClick={onToggle} aria-expanded={open}>
        <span className="grow">
          <strong>{title}</strong>
          {!open && preview && <span className="hint"> — {preview}</span>}
        </span>
        <span className="hint">{meta}</span>
      </button>
      {open && <div className="expandable-body">{children}</div>}
    </div>
  );
}
