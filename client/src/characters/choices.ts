import { allFeats, classChoiceLevels, type Ability, type Character, type CharacterChoices, type RulesData } from '../../../shared/rules.ts';

/** Something the rules ask the player to choose, given the character as it is. */
export type ChoiceNeed =
  | { kind: 'fightingStyle'; label: string; options: { index: string; name: string; description: string }[] }
  | { kind: 'expertise'; label: string; count: number; options: string[] }
  | { kind: 'speciesSkill'; label: string; options: string[] }
  | { kind: 'originFeat'; label: string; options: { index: string; name: string; description: string }[] }
  | { kind: 'skilled'; label: string; count: number }
  | { kind: 'magicInitiate'; label: string; slot: number; list: string | null }
  | { kind: 'lineageAbility'; label: string }
  | { kind: 'size'; label: string; options: string[] };

const SPELL_LISTS = ['cleric', 'druid', 'wizard'];
export const MAGIC_INITIATE_LISTS = SPELL_LISTS;

/** Everything the character still needs (or may change) to choose, up to their current level. */
export function neededChoices(c: Character, rules: RulesData): ChoiceNeed[] {
  const needs: ChoiceNeed[] = [];
  const cls = rules.classes.find((x) => x.index === c.classIndex);
  const species = rules.species.find((x) => x.index === c.speciesIndex);
  const levels = classChoiceLevels(cls);
  const ch = c.choices ?? {};

  if (levels.fightingStyle.some((l) => l <= c.level)) {
    needs.push({ kind: 'fightingStyle', label: 'Fighting Style', options: rules.feats.filter((f) => f.type === 'fighting-style') });
  }
  const expertiseCount = 2 * levels.expertise.filter((l) => l <= c.level).length + levels.scholar.filter((l) => l <= c.level).length;
  if (expertiseCount) {
    const proficient = [...c.skills, ch.speciesSkill, ...(ch.skilled ?? [])].filter((x): x is string => !!x);
    needs.push({ kind: 'expertise', label: `Expertise (${expertiseCount} skills you're proficient in)`, count: expertiseCount, options: [...new Set(proficient)] });
  }
  if (species?.traits.includes('keen-senses')) {
    needs.push({ kind: 'speciesSkill', label: 'Keen Senses: one skill', options: ['insight', 'perception', 'survival'] });
  }
  if (species?.traits.includes('skillful')) {
    needs.push({ kind: 'speciesSkill', label: 'Skillful: one extra skill', options: rules.skills.map((s) => s.index) });
  }
  if (species?.traits.includes('versatile')) {
    needs.push({ kind: 'originFeat', label: 'Versatile: an Origin feat', options: rules.feats.filter((f) => f.type === 'origin') });
  }
  const feats = allFeats(c);
  if (feats.includes('skilled')) needs.push({ kind: 'skilled', label: 'Skilled: three skills', count: 3 });
  // Magic Initiate can come from the background and from Versatile.
  const background = rules.backgrounds.find((b) => b.index === c.backgroundIndex);
  let slot = 0;
  if (background?.feat.index === 'magic-initiate') {
    const list = background.feat.note?.toLowerCase() ?? (background.index === 'sage' ? 'wizard' : null);
    needs.push({ kind: 'magicInitiate', label: `Magic Initiate${list ? ` (${list})` : ''}`, slot: slot++, list });
  }
  if (ch.originFeat === 'magic-initiate') needs.push({ kind: 'magicInitiate', label: 'Magic Initiate (Versatile)', slot: slot++, list: null });
  const sub = species?.subspecies.find((s) => s.index === c.subspeciesIndex);
  if ([...(species?.traits ?? []), ...(sub?.traits ?? [])].some((t) => t.startsWith('lineage-spell-'))) {
    needs.push({ kind: 'lineageAbility', label: 'Spellcasting ability for your species spells' });
  }
  if (species?.sizeOptions?.length) needs.push({ kind: 'size', label: 'Size', options: species.sizeOptions });
  return needs;
}

/** Whether every choice has been made. */
export function choicesComplete(c: Character, rules: RulesData): boolean {
  const ch = c.choices ?? {};
  return neededChoices(c, rules).every((n) => {
    switch (n.kind) {
      case 'fightingStyle':
        return !!ch.fightingStyle;
      case 'expertise':
        return (ch.expertise ?? []).length === Math.min(n.count, n.options.length);
      case 'speciesSkill':
        return !!ch.speciesSkill;
      case 'originFeat':
        return !!ch.originFeat;
      case 'skilled':
        return (ch.skilled ?? []).length === n.count;
      case 'magicInitiate': {
        const mi = ch.magicInitiate?.[n.slot];
        return !!mi && mi.cantrips.length === 2 && !!mi.spell;
      }
      case 'lineageAbility':
        return !!ch.lineageAbility;
      case 'size':
        return !!ch.size;
    }
  });
}

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
function sample<T>(list: T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

/** Sensible random choices for everything still open (used by "Roll me a character"). */
export function autoChoices(c: Character, rules: RulesData): CharacterChoices {
  let next: Character = { ...c, choices: { ...(c.choices ?? {}) } };
  const bestMental = (['int', 'wis', 'cha'] as Ability[]).sort((a, b) => c.abilities[b] - c.abilities[a])[0];
  // Two passes: some choices (Versatile -> Skilled / Magic Initiate) open new ones.
  for (let pass = 0; pass < 2; pass++) {
    const ch = next.choices;
    for (const n of neededChoices(next, rules)) {
      if (n.kind === 'fightingStyle' && !ch.fightingStyle) ch.fightingStyle = c.abilities.dex > c.abilities.str ? 'archery' : 'defense';
      if (n.kind === 'expertise' && (ch.expertise ?? []).length < n.count) ch.expertise = sample(n.options, n.count);
      if (n.kind === 'speciesSkill' && !ch.speciesSkill) ch.speciesSkill = pick(n.options.filter((o) => !c.skills.includes(o)));
      if (n.kind === 'originFeat' && !ch.originFeat) ch.originFeat = 'skilled';
      if (n.kind === 'skilled' && !(ch.skilled ?? []).length) {
        ch.skilled = sample(rules.skills.map((s) => s.index).filter((s) => !c.skills.includes(s) && s !== ch.speciesSkill), 3);
      }
      if (n.kind === 'magicInitiate' && !ch.magicInitiate?.[n.slot]) {
        const list = n.list ?? pick(SPELL_LISTS);
        const spells = rules.spells.filter((s) => s.classes.includes(list));
        const mi = [...(ch.magicInitiate ?? [])];
        mi[n.slot] = {
          list,
          ability: list === 'wizard' ? 'int' : 'wis',
          cantrips: sample(spells.filter((s) => s.level === 0).map((s) => s.index), 2),
          spell: pick(spells.filter((s) => s.level === 1)).index,
        };
        ch.magicInitiate = mi;
      }
      if (n.kind === 'lineageAbility' && !ch.lineageAbility) ch.lineageAbility = bestMental;
      if (n.kind === 'size' && !ch.size) ch.size = 'Medium';
    }
    next = { ...next, choices: ch };
  }
  return next.choices;
}
