import { useState } from 'react';
import { ABILITIES, ABILITY_NAMES, derive, signed, withSummary, type Character, type RulesData } from '../../../shared/rules.ts';
import { formatDistance, useSettings } from '../settings.ts';

interface Props {
  character: Character;
  rules: RulesData;
  editable: boolean;
  onSave: (c: Character) => Promise<unknown>;
  onEdit: () => void;
  /** Roll a d20 + bonus through the game (shown on the Main Screen). */
  onRoll?: (label: string, modifier: number) => void;
}

/** A character sheet: everything about the character, with the numbers worked out. */
export function CharacterSheet({ character: c, rules, editable, onSave, onEdit, onRoll }: Props) {
  const { unit } = useSettings();
  const d = derive(c, rules);
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const save = (next: Character) => onSave(withSummary(next, rules));
  const roll = (label: string, mod: number) => onRoll?.(`${c.name}: ${label}`, mod);

  function changeHp(kind: 'damage' | 'heal') {
    const n = Math.abs(parseInt(amount, 10));
    if (!n) return;
    let { current, temp } = c.hp;
    if (kind === 'damage') {
      const fromTemp = Math.min(temp, n);
      temp -= fromTemp;
      current -= n - fromTemp;
    } else current = Math.min(c.hp.max, Math.max(0, current) + n);
    save({ ...c, hp: { ...c.hp, current, temp } });
    setAmount('');
  }

  function toggleSlot(level: number, i: number) {
    const used = [...c.spellSlotsUsed];
    used[level] = i < used[level] ? i : i + 1;
    save({ ...c, spellSlotsUsed: used });
  }

  function toggleEquip(index: number) {
    const items = c.items.map((it, i) => (i === index ? { ...it, equipped: !it.equipped } : it));
    save({ ...c, items });
  }

  const subspecies = d.species?.subspecies.find((s) => s.index === c.subspeciesIndex);
  const traitIndexes = [...(d.species?.traits ?? []), ...(subspecies?.traits ?? [])];
  const traits = traitIndexes.map((t) => rules.traits.find((x) => x.index === t)).filter(Boolean);
  const features = rules.features.filter((f) => f.class === c.classIndex && f.level <= c.level && !/subclass$/.test(f.index));
  const feats = c.feats.map((f) => rules.feats.find((x) => x.index === f)).filter(Boolean);
  const background = rules.backgrounds.find((b) => b.index === c.backgroundIndex);
  const spellList = (ids: string[]) => ids.map((s) => rules.spells.find((x) => x.index === s)).filter(Boolean);
  const toggle = (key: string) => setOpen(open === key ? null : key);

  return (
    <div className="sheet" data-testid="character-sheet">
      <header className="sheet-head">
        <div className="grow">
          <h2>{c.name}</h2>
          <div className="hint">
            {d.classLine}
            {subspecies ? ` (${subspecies.name.replace(/^.*?: /, '')})` : ''} · {background?.name ?? c.backgroundIndex}
            {c.alignment ? ` · ${c.alignment}` : ''}
          </div>
        </div>
        {editable && (
          <button className="button small" onClick={onEdit}>
            Edit
          </button>
        )}
      </header>

      <section className="hp-box">
        <div>
          <div className="label">Hit points</div>
          <div className="hp" data-testid="hp">
            <strong>{c.hp.current}</strong> / {c.hp.max}
            {c.hp.temp > 0 && <span className="hint"> +{c.hp.temp} temp</span>}
          </div>
        </div>
        {editable && (
          <div className="hp-edit">
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="0" aria-label="Amount" />
            <button className="button small" onClick={() => changeHp('damage')}>Damage</button>
            <button className="button small" onClick={() => changeHp('heal')}>Heal</button>
          </div>
        )}
      </section>

      <section className="stat-row">
        <Stat label="Armour class" value={d.ac} />
        <Stat label="Initiative" value={signed(d.initiative)} onClick={onRoll && (() => roll('Initiative', d.initiative))} />
        <Stat label="Speed" value={formatDistance(d.speedFt, unit)} />
        <Stat label="Proficiency" value={signed(d.prof)} />
        <Stat label="Passive Perception" value={d.passivePerception} />
      </section>

      <section className="abilities">
        {ABILITIES.map((a) => (
          <button key={a} className="ability" onClick={() => onRoll && roll(`${ABILITY_NAMES[a]} check`, d.mods[a])} disabled={!onRoll}>
            <span className="label">{a.toUpperCase()}</span>
            <strong>{signed(d.mods[a])}</strong>
            <span className="hint">{c.abilities[a]}</span>
          </button>
        ))}
      </section>
      {onRoll && <p className="hint">Tap an ability, save or skill to roll it. Rolls show on the Main Screen.</p>}

      <section>
        <h3>Saving throws</h3>
        <div className="pill-grid">
          {ABILITIES.map((a) => (
            <button key={a} className={`pill ${d.cls?.saves.includes(a) ? 'prof' : ''}`} onClick={() => onRoll && roll(`${ABILITY_NAMES[a]} save`, d.saves[a])} disabled={!onRoll}>
              {ABILITY_NAMES[a]} <strong>{signed(d.saves[a])}</strong>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Skills</h3>
        <div className="pill-grid">
          {d.skills.map((s) => (
            <button key={s.index} className={`pill ${s.proficient ? 'prof' : ''}`} onClick={() => onRoll && roll(s.name, s.bonus)} disabled={!onRoll}>
              {s.name} <strong>{signed(s.bonus)}</strong>
            </button>
          ))}
        </div>
        <p className="hint">Bold border: proficient.</p>
      </section>

      {d.attacks.length > 0 && (
        <section>
          <h3>Attacks</h3>
          <ul className="list compact">
            {d.attacks.map((a, i) => (
              <li key={i}>
                <span className="grow">{a.name}</span>
                <button className="button small" onClick={() => onRoll && roll(`${a.name} attack`, a.toHit)} disabled={!onRoll}>
                  {signed(a.toHit)} to hit
                </button>
                <span className="hint">{a.damage}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.spellcasting && (
        <section>
          <h3>Spells</h3>
          <p className="hint">
            Spell save DC {d.spellcasting.saveDc} · spell attack {signed(d.spellcasting.attack)} · {d.spellcasting.ability.toUpperCase()}
          </p>
          {d.spellcasting.slots.some((n) => n > 0) && (
            <div className="slots">
              {d.spellcasting.slots.map((count, lvl) =>
                count > 0 ? (
                  <div key={lvl} className="slot-row">
                    <span className="label">Level {lvl + 1}</span>
                    {Array.from({ length: count }, (_, i) => (
                      <button
                        key={i}
                        className={`slot ${i < c.spellSlotsUsed[lvl] ? 'used' : ''}`}
                        onClick={() => editable && toggleSlot(lvl, i)}
                        aria-label={`Level ${lvl + 1} slot ${i + 1}${i < c.spellSlotsUsed[lvl] ? ' (used)' : ''}`}
                      />
                    ))}
                  </div>
                ) : null,
              )}
            </div>
          )}
          {[...spellList(c.cantrips), ...spellList(c.spells)].map((s) => (
            <Expandable key={s!.index} title={s!.name} meta={s!.level === 0 ? 'Cantrip' : `Level ${s!.level}`} open={open === s!.index} onToggle={() => toggle(s!.index)}>
              <p className="hint">
                {s!.castingTime} · {s!.range} · {s!.duration}
                {s!.concentration ? ' · concentration' : ''}
              </p>
              <p className="prose">{s!.description}</p>
            </Expandable>
          ))}
        </section>
      )}

      <section>
        <h3>Features and traits</h3>
        {features.map((f) => (
          <Expandable key={f.index} title={f.name} meta={`${d.cls?.name} ${f.level}`} open={open === f.index} onToggle={() => toggle(f.index)}>
            <p className="prose">{f.description}</p>
          </Expandable>
        ))}
        {traits.map((t) => (
          <Expandable key={t!.index} title={t!.name} meta={d.species?.name ?? ''} open={open === t!.index} onToggle={() => toggle(t!.index)}>
            <p className="prose">{t!.description}</p>
          </Expandable>
        ))}
        {feats.map((f) => (
          <Expandable key={f!.index} title={f!.name} meta="Feat" open={open === f!.index} onToggle={() => toggle(f!.index)}>
            <p className="prose">{f!.description}</p>
          </Expandable>
        ))}
      </section>

      <section>
        <h3>Equipment</h3>
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
                    <button className={`chip ${it.equipped ? 'on' : ''}`} onClick={() => toggleEquip(i)}>
                      {it.equipped ? 'Worn' : 'Wear'}
                    </button>
                  ) : (
                    it.equipped && <span className="hint">worn</span>
                  ))}
              </li>
            );
          })}
          <li>
            <span className="grow">Gold</span>
            <strong>{c.gold} gp</strong>
          </li>
        </ul>
        <p className="hint">Languages: {c.languages.join(', ') || '–'}</p>
      </section>

      {Object.values(c.details).some(Boolean) && (
        <section>
          <h3>About</h3>
          {(['appearance', 'personality', 'ideals', 'bonds', 'flaws', 'backstory'] as const).map((k) =>
            c.details[k] ? (
              <div key={k} className="detail">
                <div className="label">{k[0].toUpperCase() + k.slice(1)}</div>
                <p className="prose">{c.details[k]}</p>
              </div>
            ) : null,
          )}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }) {
  return (
    <button className="stat" onClick={onClick} disabled={!onClick}>
      <strong>{value}</strong>
      <span className="label">{label}</span>
    </button>
  );
}

function Expandable({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`expandable ${open ? 'open' : ''}`}>
      <button className="expandable-head" onClick={onToggle} aria-expanded={open}>
        <span className="grow">{title}</span>
        <span className="hint">{meta}</span>
      </button>
      {open && <div className="expandable-body">{children}</div>}
    </div>
  );
}
