import { ABILITY_NAMES, type Ability, type Character, type CharacterChoices, type RulesData } from '../../../shared/rules.ts';
import { MAGIC_INITIATE_LISTS, neededChoices } from './choices.ts';

/**
 * The choices the rules ask for (fighting style, expertise, species skill,
 * extra feat, Magic Initiate spells, ...), for the builder, the editor and levelling up.
 */
export function RuleChoices({
  character,
  rules,
  onChange,
}: {
  character: Character;
  rules: RulesData;
  onChange: (choices: CharacterChoices) => void;
}) {
  const ch = character.choices ?? {};
  const needs = neededChoices(character, rules);
  const set = (patch: Partial<CharacterChoices>) => onChange({ ...ch, ...patch });
  const skillName = (i: string) => rules.skills.find((s) => s.index === i)?.name ?? i;
  if (!needs.length) return <p className="hint">Nothing to choose for this character.</p>;

  const toggleIn = (list: string[] | undefined, value: string, max: number) => {
    const cur = list ?? [];
    return cur.includes(value) ? cur.filter((x) => x !== value) : cur.length < max ? [...cur, value] : cur;
  };

  return (
    <div className="rule-choices" data-testid="rule-choices">
      {needs.map((n, i) => {
        switch (n.kind) {
          case 'fightingStyle':
          case 'originFeat': {
            const value = n.kind === 'fightingStyle' ? ch.fightingStyle : ch.originFeat;
            return (
              <fieldset key={i}>
                <legend>{n.label}</legend>
                <div className="choice-list">
                  {n.options.map((o) => (
                    <button
                      key={o.index}
                      className={`choice ${value === o.index ? 'on' : ''}`}
                      onClick={() => set(n.kind === 'fightingStyle' ? { fightingStyle: o.index } : { originFeat: o.index })}
                    >
                      <strong>{o.name}</strong>
                      <span className="hint">{o.description.replace(/\*\*/g, '').slice(0, 160)}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            );
          }
          case 'expertise':
          case 'speciesSkill':
          case 'skilled': {
            const options = n.kind === 'skilled' ? rules.skills.map((s) => s.index) : n.options;
            const max = n.kind === 'speciesSkill' ? 1 : n.count;
            const chosen = n.kind === 'expertise' ? (ch.expertise ?? []) : n.kind === 'skilled' ? (ch.skilled ?? []) : ch.speciesSkill ? [ch.speciesSkill] : [];
            return (
              <fieldset key={i}>
                <legend>
                  {n.label} ({chosen.length}/{max})
                </legend>
                {options.length === 0 && <p className="hint">Choose skills first.</p>}
                <div className="pill-grid">
                  {options.map((o) => {
                    const on = chosen.includes(o);
                    return (
                      <button
                        key={o}
                        className={`pill ${on ? 'prof on' : ''}`}
                        disabled={!on && chosen.length >= max && max > 1}
                        onClick={() =>
                          set(
                            n.kind === 'expertise'
                              ? { expertise: toggleIn(ch.expertise, o, max) }
                              : n.kind === 'skilled'
                                ? { skilled: toggleIn(ch.skilled, o, max) }
                                : { speciesSkill: on ? undefined : o },
                          )
                        }
                      >
                        {skillName(o)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          }
          case 'magicInitiate': {
            const mi = ch.magicInitiate?.[n.slot] ?? { list: n.list ?? 'wizard', ability: 'int' as Ability, cantrips: [], spell: '' };
            const update = (patch: Partial<typeof mi>) => {
              const all = [...(ch.magicInitiate ?? [])];
              all[n.slot] = { ...mi, ...patch };
              set({ magicInitiate: all });
            };
            const spells = rules.spells.filter((s) => s.classes.includes(mi.list));
            return (
              <fieldset key={i}>
                <legend>{n.label}</legend>
                <div className="grid-2">
                  {!n.list && (
                    <label>
                      Spell list
                      <select value={mi.list} onChange={(e) => update({ list: e.target.value, cantrips: [], spell: '' })}>
                        {MAGIC_INITIATE_LISTS.map((l) => (
                          <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Spellcasting ability
                    <select value={mi.ability} onChange={(e) => update({ ability: e.target.value as Ability })}>
                      {(['int', 'wis', 'cha'] as Ability[]).map((a) => (
                        <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="label">Two cantrips ({mi.cantrips.length}/2)</div>
                <div className="pill-grid">
                  {spells.filter((s) => s.level === 0).map((s) => {
                    const on = mi.cantrips.includes(s.index);
                    return (
                      <button key={s.index} className={`pill ${on ? 'prof on' : ''}`} disabled={!on && mi.cantrips.length >= 2} onClick={() => update({ cantrips: toggleIn(mi.cantrips, s.index, 2) })}>
                        {s.name}
                      </button>
                    );
                  })}
                </div>
                <div className="label">One level 1 spell</div>
                <div className="pill-grid">
                  {spells.filter((s) => s.level === 1).map((s) => (
                    <button key={s.index} className={`pill ${mi.spell === s.index ? 'prof on' : ''}`} onClick={() => update({ spell: s.index })}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </fieldset>
            );
          }
          case 'lineageAbility':
            return (
              <label key={i}>
                {n.label}
                <select value={ch.lineageAbility ?? ''} onChange={(e) => set({ lineageAbility: (e.target.value || undefined) as Ability | undefined })} aria-label="Species spell ability">
                  <option value="">Choose…</option>
                  {(['int', 'wis', 'cha'] as Ability[]).map((a) => (
                    <option key={a} value={a}>{ABILITY_NAMES[a]}</option>
                  ))}
                </select>
              </label>
            );
          case 'size':
            return (
              <label key={i}>
                {n.label}
                <select value={ch.size ?? ''} onChange={(e) => set({ size: e.target.value || undefined })} aria-label="Size">
                  <option value="">Choose…</option>
                  {n.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            );
        }
      })}
    </div>
  );
}
