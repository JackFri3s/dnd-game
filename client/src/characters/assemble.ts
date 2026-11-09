import {
  ABILITIES,
  emptyCharacter,
  mod,
  withSummary,
  bonusHp,
  type Ability,
  type Character,
  type CharacterItem,
  type EquipmentOption,
  type RulesData,
} from '../../../shared/rules.ts';
import { STANDARD_LANGUAGES, randomName } from '../rules/index.ts';
import { autoChoices } from './choices.ts';

/** Starting gear as inventory: packs are listed with their contents; the first armour and shield are worn. */
export function expandEquipment(rules: RulesData, options: (EquipmentOption | undefined)[]): { items: CharacterItem[]; gold: number } {
  const items: CharacterItem[] = [];
  let gold = 0;
  for (const opt of options) {
    gold += opt?.gold ?? 0;
    for (const it of opt?.items ?? []) {
      const r = it.index ? rules.items.find((x) => x.index === it.index) : undefined;
      items.push({ ...it });
      if (r?.kind === 'pack' && r.contents) {
        for (const inner of r.contents) items.push({ index: inner.index, name: inner.name, qty: inner.qty * it.qty });
      }
    }
  }
  const kind = (i: CharacterItem) => rules.items.find((r) => r.index === i.index)?.kind;
  const armor = items.findIndex((i) => kind(i) === 'armor');
  const shield = items.findIndex((i) => kind(i) === 'shield');
  if (armor >= 0) items[armor].equipped = true;
  if (shield >= 0) items[shield].equipped = true;
  return { items, gold };
}

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
function sample<T>(list: T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

/**
 * A complete level-1 character from a few choices (or none) and six rolled
 * ability scores: the best score goes to the class's main ability, then
 * Constitution, then Dexterity; everything else is picked sensibly at random.
 */
export function quickCharacter(
  rules: RulesData,
  choice: { classIndex?: string; speciesIndex?: string; backgroundIndex?: string; name?: string },
  rolledScores: number[],
): Character {
  const cls = rules.classes.find((c) => c.index === choice.classIndex) ?? pick(rules.classes);
  const species = rules.species.find((s) => s.index === choice.speciesIndex) ?? pick(rules.species);
  const background = rules.backgrounds.find((b) => b.index === choice.backgroundIndex) ?? pick(rules.backgrounds);

  // Highest scores to the abilities this class needs most.
  const primary = pick(cls.primary);
  const order: Ability[] = [primary, ...cls.primary.filter((a) => a !== primary), 'con', 'dex', 'wis', 'cha', 'int', 'str'].filter(
    (a, i, arr) => arr.indexOf(a) === i,
  ) as Ability[];
  const scores = [...rolledScores].sort((a, b) => b - a);
  const abilities = Object.fromEntries(ABILITIES.map((a) => [a, scores[order.indexOf(a)] ?? 10])) as Record<Ability, number>;

  // Background bonus: +2 to the best fitting ability and +1 to the next, or +1 to all three.
  const bgOrder = background.abilities.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (background.abilities.includes(primary)) {
    abilities[bgOrder[0]] = Math.min(20, abilities[bgOrder[0]] + 2);
    abilities[bgOrder[1]] = Math.min(20, abilities[bgOrder[1]] + 1);
  } else {
    for (const a of background.abilities) abilities[a] = Math.min(20, abilities[a] + 1);
  }

  const level1 = cls.levels[0];
  const classSpells = rules.spells.filter((s) => s.classes.includes(cls.index));
  const classSkills = cls.skillChoice.from.filter((s) => !background.skills.includes(s));
  const pool = classSkills.length >= cls.skillChoice.choose ? classSkills : rules.skills.map((s) => s.index).filter((s) => !background.skills.includes(s));
  const skills = sample(pool, cls.skillChoice.choose);
  const { items, gold } = expandEquipment(rules, [cls.equipment[0], background.equipment[0]]);
  const hp = Math.max(1, cls.hitDie + mod(abilities.con) + bonusHp({ speciesIndex: species.index, level: 1 }));

  const draft: Character = {
      ...emptyCharacter(),
      name: choice.name?.trim() || randomName(),
      classIndex: cls.index,
      speciesIndex: species.index,
      subspeciesIndex: species.subspecies.length ? pick(species.subspecies).index : null,
      backgroundIndex: background.index,
      abilities,
      abilityMethod: 'roll',
      skills: [...background.skills, ...skills],
      languages: ['Common', ...sample(STANDARD_LANGUAGES, 2)],
      feats: [background.feat.index],
      items,
      gold,
      cantrips: sample(classSpells.filter((s) => s.level === 0).map((s) => s.index), level1.cantrips ?? 0),
      spells: sample(classSpells.filter((s) => s.level === 1).map((s) => s.index), level1.prepared ?? 0),
      hp: { max: hp, current: hp, temp: 0 },
      createdWith: 'builder',
  };
  return withSummary({ ...draft, choices: autoChoices(draft, rules) }, rules);
}
