// Custom content ("homebrew") for a campaign: species, classes, spells and items
// made by the DM or players, kept within the limits of the rules, and merged
// with the official rules so builders, sheets and spell lists use them.

import type { Ability, AreaShape, ClassLevel, RulesClass, RulesData, RulesItem, RulesSpecies, RulesSpell, RulesText } from './rules.ts';

export const DAMAGE_TYPES = ['Acid', 'Bludgeoning', 'Cold', 'Fire', 'Force', 'Lightning', 'Necrotic', 'Piercing', 'Poison', 'Psychic', 'Radiant', 'Slashing', 'Thunder'];
export const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
export const WEAPON_PROPERTIES = ['Ammunition', 'Finesse', 'Heavy', 'Light', 'Loading', 'Reach', 'Thrown', 'Two-Handed', 'Versatile'];

export interface HomebrewBase {
  id: string;
  name: string;
  by: string; // who made it (member name)
  byId: string; // member id
}

export interface HomebrewSpecies extends HomebrewBase {
  size: 'Small' | 'Medium';
  speed: number; // 20-40
  darkvision: 0 | 60 | 120;
  resistances: string[]; // damage types
  traits: { name: string; description: string }[];
}

export interface HomebrewClass extends HomebrewBase {
  hitDie: 6 | 8 | 10 | 12;
  primary: Ability;
  saves: Ability[]; // exactly two
  skillCount: number; // 2-4
  skills: string[]; // skill indexes to choose from
  armor: ('Light' | 'Medium' | 'Heavy' | 'Shields')[];
  weapons: ('Simple' | 'Martial')[];
  caster: 'none' | 'full' | 'half' | 'pact';
  spellAbility: Ability;
  /** Which official class's spell list it uses (plus custom spells made for it). */
  spellList?: string;
  features: { level: number; name: string; description: string }[];
  subclasses: string[];
}

export interface HomebrewSpell extends HomebrewBase {
  level: number; // 0-9
  school: string;
  classes: string[]; // class indexes (official or custom)
  castingTime: string;
  rangeFt: number; // 0 = self, 5 = touch
  duration: string;
  concentration: boolean;
  ritual: boolean;
  damage: string; // e.g. "3d6 Fire" or ""
  save: Ability | '';
  attack: '' | 'melee' | 'ranged';
  area: { shape: AreaShape; size: number } | null;
  description: string;
}

export interface HomebrewItem extends HomebrewBase {
  kind: 'weapon' | 'armor' | 'shield' | 'gear';
  description: string;
  weapon?: { category: 'simple' | 'martial'; damage: string; type: string; properties: string[]; ranged: boolean; normal?: number; long?: number };
  armor?: { category: 'light' | 'medium' | 'heavy'; base: number };
}

export interface Homebrew {
  species: HomebrewSpecies[];
  classes: HomebrewClass[];
  spells: HomebrewSpell[];
  items: HomebrewItem[];
}

export type HomebrewKind = keyof Homebrew;
export const emptyHomebrew = (): Homebrew => ({ species: [], classes: [], spells: [], items: [] });

/** The rule limits each kind must stay within. Returns a problem, or null when fine. */
export function checkHomebrew(kind: HomebrewKind, e: Record<string, unknown>): string | null {
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  if (!name) return 'Give it a name.';
  const dice = (s: unknown) => typeof s === 'string' && /^\d{1,2}d(4|6|8|10|12|20)( [A-Za-z]+)?$/.test(s.trim());
  if (kind === 'species') {
    const s = e as unknown as HomebrewSpecies;
    if (!['Small', 'Medium'].includes(s.size)) return 'Size must be Small or Medium.';
    if (!(s.speed >= 20 && s.speed <= 40 && s.speed % 5 === 0)) return 'Speed must be 20 to 40 feet, in steps of 5.';
    if (![0, 60, 120].includes(s.darkvision)) return 'Darkvision is none, 60 or 120 feet.';
    if ((s.resistances ?? []).length > 2) return 'At most two damage resistances.';
    if ((s.traits ?? []).length > 6) return 'At most six traits.';
  }
  if (kind === 'classes') {
    const c = e as unknown as HomebrewClass;
    if (![6, 8, 10, 12].includes(c.hitDie)) return 'The hit die must be d6, d8, d10 or d12.';
    if (!c.saves || c.saves.length !== 2 || c.saves[0] === c.saves[1]) return 'Choose two different saving throws.';
    if (!(c.skillCount >= 2 && c.skillCount <= 4)) return 'Players choose 2 to 4 skills.';
    if ((c.skills ?? []).length < c.skillCount) return 'Offer at least as many skills as players choose.';
    if (!['none', 'full', 'half', 'pact'].includes(c.caster)) return 'Unknown spellcasting type.';
    if (c.caster === 'full' && c.hitDie > 8) return 'Full spellcasters have a d6 or d8 hit die.';
    if ((c.armor ?? []).includes('Heavy') && c.caster === 'full') return 'Full spellcasters do not get heavy armour.';
    if ((c.features ?? []).some((f) => !(f.level >= 1 && f.level <= 20))) return 'Features are gained at levels 1 to 20.';
  }
  if (kind === 'spells') {
    const s = e as unknown as HomebrewSpell;
    if (!(Number.isInteger(s.level) && s.level >= 0 && s.level <= 9)) return 'Spell level is 0 (cantrip) to 9.';
    if (s.damage && !dice(s.damage)) return 'Damage must look like "3d6 Fire".';
    if (s.level === 0 && s.damage && Number(s.damage.split('d')[0]) > 2) return 'A cantrip deals at most 2 dice of damage.';
    if (!(s.rangeFt >= 0 && s.rangeFt <= 1000)) return 'Range is 0 (self) to 1000 feet.';
    if (s.area && !(s.area.size >= 5 && s.area.size <= 120)) return 'An area is 5 to 120 feet.';
    if (!s.classes?.length) return 'Choose at least one class that can learn it.';
  }
  if (kind === 'items') {
    const it = e as unknown as HomebrewItem;
    if (it.kind === 'weapon') {
      if (!it.weapon || !dice(it.weapon.damage)) return 'Weapon damage must look like "1d8".';
      const sides = Number(it.weapon.damage.split('d')[1]);
      if (Number(it.weapon.damage.split('d')[0]) * sides > 12) return 'A weapon deals at most 12 damage on its dice (like 2d6 or 1d12).';
    }
    if (it.kind === 'armor') {
      const limits = { light: [11, 12], medium: [12, 15], heavy: [14, 18] } as const;
      const a = it.armor;
      if (!a || !limits[a.category] || a.base < limits[a.category][0] || a.base > limits[a.category][1]) return 'Armour class: light 11–12, medium 12–15, heavy 14–18.';
    }
  }
  return null;
}

/** Spell slots and spells known come from a similar official class. */
const CASTER_MODEL: Record<HomebrewClass['caster'], string | null> = { none: null, full: 'wizard', half: 'paladin', pact: 'warlock' };

/** The official rules plus this campaign's custom content. */
export function mergeHomebrew(rules: RulesData, hb: Homebrew | undefined): RulesData {
  if (!hb || (!hb.species.length && !hb.classes.length && !hb.spells.length && !hb.items.length)) return rules;
  const traits: RulesText[] = [];
  const features: RulesData['features'] = [];

  const species: RulesSpecies[] = hb.species.map((s) => {
    const own = s.traits.map((t, i) => {
      const index = `hb-${s.id}-trait-${i}`;
      traits.push({ index, name: t.name, description: t.description });
      return index;
    });
    const resist = s.resistances.map((r) => {
      const index = `lineage-resistance-${r.toLowerCase()}`;
      if (!rules.traits.some((t) => t.index === index)) traits.push({ index, name: `${r} Resistance`, description: `You have Resistance to ${r} damage.` });
      return index;
    });
    return {
      index: `hb-${s.id}`,
      name: `${s.name} (custom)`,
      size: s.size,
      speed: s.speed,
      traits: [...(s.darkvision ? [`darkvision-${s.darkvision}`] : []), ...resist, ...own],
      subspecies: [],
    };
  });

  const classes: RulesClass[] = hb.classes.map((c) => {
    const index = `hb-${c.id}`;
    const model = rules.classes.find((x) => x.index === CASTER_MODEL[c.caster]);
    const levels: ClassLevel[] = Array.from({ length: 20 }, (_, i) => {
      const level = i + 1;
      const ids: string[] = [];
      c.features.forEach((f, n) => {
        if (f.level !== level) return;
        const id = `${index}-feature-${n}`;
        features.push({ index: id, name: f.name, description: f.description, class: index, level });
        ids.push(id);
      });
      if ([4, 8, 12, 16].includes(level)) ids.push(`${index}-ability-score-improvement`);
      if (level === 19) ids.push(`${index}-epic-boon`);
      if (level === 3 && c.subclasses.length) ids.push(`${index}-subclass`);
      const m = model?.levels[i];
      return {
        level,
        profBonus: 2 + Math.floor(i / 4),
        features: ids,
        ...(m?.slots ? { slots: m.slots, cantrips: m.cantrips, prepared: m.prepared } : {}),
      };
    });
    return {
      index,
      name: `${c.name} (custom)`,
      hitDie: c.hitDie,
      primary: [c.primary],
      saves: c.saves,
      skillChoice: { choose: c.skillCount, from: c.skills },
      proficiencies: [
        ...c.armor.map((a) => (a === 'Shields' ? 'Shields' : `${a} Armor`)),
        ...c.weapons.map((w) => `${w} Weapons`),
      ],
      equipment: [{ label: 'A', items: [], gold: c.hitDie >= 10 ? 150 : 100 }],
      spellcasting: c.caster === 'none' ? null : c.spellAbility,
      subclasses: c.subclasses.map((s, i) => ({ index: `${index}-sub-${i}`, name: s })),
      levels,
    };
  });

  const spells: RulesSpell[] = hb.spells.map((s) => ({
    index: `hb-${s.id}`,
    name: `${s.name}`,
    level: s.level,
    school: s.school,
    classes: s.classes,
    castingTime: s.castingTime,
    range: s.rangeFt === 0 ? 'Self' : s.rangeFt === 5 ? 'Touch' : `${s.rangeFt} feet`,
    components: 'V, S',
    duration: s.duration,
    concentration: s.concentration,
    ritual: s.ritual,
    description: `${s.description}\n(Custom spell by ${s.by}.)`,
    rangeFt: s.rangeFt,
    ...(s.area ? { area: { shape: s.area.shape, size: s.area.size } } : {}),
    ...(s.attack ? { attack: s.attack } : {}),
    ...(s.damage ? { damage: s.damage } : {}),
    ...(s.save ? { save: s.save } : {}),
  }));

  const items: RulesItem[] = hb.items.map((it) => ({
    index: `hb-${it.id}`,
    name: it.name,
    kind: it.kind === 'gear' ? 'gear' : it.kind,
    ...(it.kind === 'weapon' && it.weapon
      ? {
          weapon: {
            category: it.weapon.category,
            damage: it.weapon.damage,
            type: it.weapon.type,
            properties: it.weapon.properties,
            ranged: it.weapon.ranged,
            ...(it.weapon.normal ? { range: { normal: it.weapon.normal, ...(it.weapon.long ? { long: it.weapon.long } : {}) } } : {}),
          },
        }
      : {}),
    ...(it.kind === 'armor' && it.armor
      ? { armor: { base: it.armor.base, dex: it.armor.category !== 'heavy', category: it.armor.category, ...(it.armor.category === 'medium' ? { maxDex: 2 } : {}) } }
      : {}),
  }));

  // Custom casters use an official spell list as well.
  const borrowed = hb.classes.filter((c) => c.caster !== 'none' && c.spellList);
  const officialSpells = borrowed.length
    ? rules.spells.map((s) => {
        const extra = borrowed.filter((c) => s.classes.includes(c.spellList!)).map((c) => `hb-${c.id}`);
        return extra.length ? { ...s, classes: [...s.classes, ...extra] } : s;
      })
    : rules.spells;

  return {
    ...rules,
    species: [...rules.species, ...species],
    classes: [...rules.classes, ...classes],
    spells: [...officialSpells, ...spells],
    items: [...rules.items, ...items],
    traits: [...rules.traits, ...traits],
    features: [...rules.features, ...features],
  };
}
