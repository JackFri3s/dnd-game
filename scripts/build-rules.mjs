// Builds client/src/rules/srd-2024.json from the open-source 5e-database
// (https://github.com/5e-bits/5e-database, MIT), which holds the D&D 2024
// System Reference Document 5.2.1 (CC-BY-4.0) as JSON.
//
//   node scripts/build-rules.mjs                 # downloads the pinned version
//   node scripts/build-rules.mjs path/to/src/2024/en
//
// Only the parts the app uses are kept, in a compact shape (see shared/rules.ts).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const COMMIT = 'a6212beb4b278917c2cff41c2b04c4ef4f3e0d6f';
const BASE = `https://raw.githubusercontent.com/5e-bits/5e-database/${COMMIT}/src/2024/en`;
const OUT = new URL('../client/src/rules/srd-2024.json', import.meta.url);
const localDir = process.argv[2];

async function load(name) {
  const file = `5e-SRD-${name}.json`;
  const text = localDir
    ? await readFile(path.join(localDir, file), 'utf8')
    : await (await fetch(`${BASE}/${file}`)).text();
  return JSON.parse(fixText(text));
}

// Some texts in the source were saved with the wrong encoding ("â€™" instead of "’").
function fixText(s) {
  return s
    .replaceAll('â€™', '’')
    .replaceAll('â€œ', '“')
    .replaceAll('â€\u009d', '”')
    .replaceAll('â€"', '–')
    .replaceAll('â€”', '—');
}

const [classes, levels, species, subspecies, backgrounds, feats, skills, spells, equipment, traits, features, languages, alignments, conditions, monsters] =
  await Promise.all(
    ['Classes', 'Levels', 'Species', 'Subspecies', 'Backgrounds', 'Feats', 'Skills', 'Spells', 'Equipment', 'Traits', 'Features', 'Languages', 'Alignments', 'Conditions', 'Monsters'].map(load),
  );

const skillIndex = (profIndex) => profIndex.replace(/^skill-/, '');

/** "60 feet" -> 60, "Self" -> 0, "Touch" -> 5, "1 mile" -> 5280; null for "Sight", "Special", ... */
function rangeFeet(range = '') {
  const r = range.toLowerCase();
  if (r.startsWith('self')) return 0;
  if (r.startsWith('touch')) return 5;
  const ft = r.match(/^(\d+) feet/);
  if (ft) return Number(ft[1]);
  const mi = r.match(/^(\d+) miles?/);
  if (mi) return Number(mi[1]) * 5280;
  return null;
}

/** Damage at the spell's own level (cantrips: at character level 1), e.g. "8d6 Fire". */
function spellDamage(s) {
  const levels = s.damage?.damage_at_slot_level ?? s.damage?.damage_at_character_level;
  if (!levels) return {};
  const dice = levels[String(s.level)] ?? levels[Object.keys(levels).sort((a, b) => a - b)[0]];
  return dice ? { damage: `${dice} ${s.damage.damage_type?.name ?? ''}`.trim() } : {};
}

/** Higher-level casting, cantrip scaling, healing and the condition a failed save gives. */
function spellExtras(s) {
  const text = `${s.description ?? ''} ${s.higher_level ?? ''}`;
  const out = {};
  const up = text.match(/increases by (\d+)d(\d+) for each (?:spell slot )?level above/);
  if (up) out.upcast = { count: Number(up[1]), sides: Number(up[2]) };
  if (/Cantrip Upgrade/.test(text) && s.level === 0) out.cantripScales = true;
  const heal = text.match(/regains? (?:a number of )?Hit Points equal to (\d+d\d+)/);
  if (heal) out.healing = heal[1];
  const cond = text.match(/(?:have|has|gains?) the (Blinded|Charmed|Deafened|Frightened|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Poisoned|Prone|Restrained|Stunned|Unconscious) condition/);
  if (cond && s.description.includes('saving throw')) out.condition = cond[1].toLowerCase();
  return out;
}

/** The saving throw a spell asks for ("makes a Dexterity saving throw" -> "dex"). */
function spellSave(text = '') {
  const m = text.match(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/);
  return m ? { save: m[1].slice(0, 3).toLowerCase() } : {};
}

/** The spell's area (e.g. "20-foot-radius Sphere"), read from its description. */
function spellArea(text = '') {
  const t = text.replace(/(\d+)foot/g, '$1-foot').replace(/foothigh/g, 'foot-high');
  let m = t.match(/(\d+)-foot-long,? (\d+)-foot-wide Line/i) ?? null;
  if (m) return { shape: 'line', size: Number(m[1]), width: Number(m[2]) };
  m = t.match(/(\d+)-foot-wide,? (\d+)-foot-long Line/i);
  if (m) return { shape: 'line', size: Number(m[2]), width: Number(m[1]) };
  m = t.match(/Line (?:that is )?(\d+) feet long and (\d+) feet wide/i);
  if (m) return { shape: 'line', size: Number(m[1]), width: Number(m[2]) };
  m = t.match(/(\d+)-foot(?:-radius)?(?:,? \d+-foot-(?:high|tall))?,? (Sphere|Cone|Cube|Cylinder|Emanation)/i);
  if (m) return { shape: m[2].toLowerCase(), size: Number(m[1]) };
  return null;
}

/** Turns the source's nested "option" objects into simple A/B equipment choices. */
function equipmentOptions(list = []) {
  const out = [];
  for (const choice of list) {
    for (const option of choice.from?.options ?? []) {
      const parts = option.option_type === 'multiple' ? option.items : [option];
      const items = [];
      let gold = 0;
      for (const p of parts) {
        if (p.option_type === 'money') gold += p.count;
        else if (p.option_type === 'counted_reference') {
          const isCategory = p.of.url?.includes('equipment-categories');
          items.push({ index: isCategory ? null : p.of.index, name: p.of.note ? `${p.of.name} (${p.of.note})` : p.of.name, qty: p.count });
        } else if (p.option_type === 'choice') {
          const desc = p.choice.desc ?? p.choice.from?.equipment_category?.name ?? 'Item';
          items.push({ index: null, name: `${desc.replace(/^An? /, '')} of your choice`, qty: 1 });
        }
      }
      out.push({ label: String.fromCharCode(65 + out.length), items, gold });
    }
  }
  return out;
}

const levelRows = (cls) =>
  levels
    .filter((l) => l.class?.index === cls && !l.subclass)
    .sort((a, b) => a.level - b.level)
    .map((l) => {
      const row = { level: l.level, profBonus: l.prof_bonus, features: (l.features ?? []).map((f) => f.index) };
      if (l.class_specific) {
        // e.g. rage_count, sneak_attack {dice_count, dice_value}, martial_arts_die
        row.numbers = Object.fromEntries(
          Object.entries(l.class_specific).map(([k, v]) => [k, typeof v === 'object' && v ? `${v.dice_count}d${v.dice_value}` : v]),
        );
      }
      const sc = l.spellcasting;
      if (sc) {
        row.cantrips = sc.cantrips_known ?? 0;
        row.prepared = sc.prepared_spells ?? 0;
        row.slots = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => sc[`spell_slots_level_${n}`] ?? 0);
      }
      return row;
    });

const data = {
  source:
    'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode. Data prepared by the 5e-database project (MIT).',
  skills: skills.map((s) => ({ index: s.index, name: s.name, ability: s.ability_score.index })),
  classes: classes.map((c) => {
    const skillChoice = c.proficiency_choices.find((p) => p.from?.options?.some((o) => o.item?.index?.startsWith('skill-')));
    return {
      index: c.index,
      name: c.name,
      hitDie: c.hit_die,
      primary: (c.primary_ability.ability_scores ?? c.primary_ability.ability_score_options?.from.options.map((o) => o.item) ?? []).map(
        (a) => a.index,
      ),
      saves: c.saving_throws.map((a) => a.index),
      skillChoice: {
        choose: skillChoice?.choose ?? 2,
        from: (skillChoice?.from.options ?? []).map((o) => skillIndex(o.item.index)),
      },
      proficiencies: c.proficiencies.filter((p) => !p.index.startsWith('saving-throw')).map((p) => p.name),
      equipment: equipmentOptions(c.starting_equipment_options),
      spellcasting: c.spellcasting?.spellcasting_ability?.index ?? null,
      subclasses: c.subclasses.map((s) => ({ index: s.index, name: s.name })),
      levels: levelRows(c.index),
    };
  }),
  species: species.map((s) => ({
    index: s.index,
    name: s.name,
    size: s.size ?? (s.size_options?.from?.options ?? []).map((o) => o.size).join(' or '),
    ...(s.size_options ? { sizeOptions: s.size_options.from.options.map((o) => o.size) } : {}),
    speed: s.speed,
    traits: s.traits.map((t) => t.index),
    subspecies: (s.subspecies ?? []).map((ref) => {
      const sub = subspecies.find((x) => x.index === ref.index);
      return { index: ref.index, name: ref.name, traits: (sub?.traits ?? []).map((t) => t.index), traitLevels: Object.fromEntries((sub?.traits ?? []).map((t) => [t.index, t.level ?? 1])) };
    }),
  })),
  backgrounds: backgrounds.map((b) => ({
    index: b.index,
    name: b.name,
    abilities: b.ability_scores.map((a) => a.index),
    feat: { index: b.feat.index, name: b.feat.name, ...(b.feat.note ? { note: b.feat.note } : {}) },
    skills: b.proficiencies.filter((p) => p.index.startsWith('skill-')).map((p) => skillIndex(p.index)),
    tools: b.proficiencies.filter((p) => !p.index.startsWith('skill-')).map((p) => p.name.replace(/^Tool: /, '')),
    equipment: equipmentOptions(b.equipment_options),
  })),
  feats: feats.map((f) => ({ index: f.index, name: f.name, type: f.type ?? 'general', ...(f.prerequisites?.minimum_level ? { minLevel: f.prerequisites.minimum_level } : {}), description: f.description ?? '' })),
  traits: traits.map((t) => ({ index: t.index, name: t.name, description: t.description ?? '' })),
  features: features.map((f) => ({
    index: f.index,
    name: f.name,
    class: f.class?.index ?? '',
    ...(f.subclass ? { subclass: f.subclass.index } : {}),
    level: f.level?.index ? Number(f.level.index.split('-').pop()) : 1,
    description: f.description ?? '',
  })),
  spells: spells.map((s) => ({
    index: s.index,
    name: s.name,
    level: s.level,
    school: s.school?.name ?? '',
    classes: (s.classes ?? []).map((c) => c.index),
    castingTime: s.casting_time ?? '',
    range: (s.range ?? '').replace(/ Component:.*$/, ''),
    rangeFt: rangeFeet(s.range),
    ...(spellArea(s.description) ? { area: spellArea(s.description) } : {}),
    ...(s.attack_type ? { attack: s.attack_type } : {}),
    ...spellDamage(s),
    ...spellSave(s.description),
    ...spellExtras(s),
    components: [(s.components ?? []).join(', '), s.material ? `(${s.material})` : ''].filter(Boolean).join(' '),
    duration: s.duration ?? '',
    concentration: !!s.concentration,
    ritual: !!s.ritual,
    description: s.description ?? '',
  })),
  items: equipment.map((e) => {
    const cats = (e.equipment_categories ?? []).map((c) => c.index);
    const item = { index: e.index, name: e.name, kind: 'other' };
    if (cats.includes('shields')) item.kind = 'shield';
    else if (e.armor_class) {
      item.kind = 'armor';
      const category = cats.includes('heavy-armor') ? 'heavy' : cats.includes('medium-armor') ? 'medium' : 'light';
      item.armor = { base: e.armor_class.base, dex: !!e.armor_class.dex_bonus, category };
      if (e.armor_class.max_bonus) item.armor.maxDex = e.armor_class.max_bonus;
    } else if (e.damage) {
      item.kind = 'weapon';
      item.weapon = {
        category: cats.includes('martial-weapons') ? 'martial' : 'simple',
        damage: e.damage.damage_dice,
        type: e.damage.damage_type?.name ?? '',
        properties: (e.properties ?? []).map((p) => p.name),
        ranged: cats.includes('ranged-weapons'),
      };
      if (e.range?.normal) item.weapon.range = { normal: e.range.normal, ...(e.range.long ? { long: e.range.long } : {}) };
      // Thrown melee weapons (javelin, dagger, handaxe...): their throwing range.
      if (e.throw_range?.normal) item.weapon.range = { normal: e.throw_range.normal, ...(e.throw_range.long ? { long: e.throw_range.long } : {}) };
    } else if (e.contents) {
      item.kind = 'pack';
      item.contents = e.contents.map((c) => ({ index: c.item.index, name: c.item.name, qty: c.quantity }));
    } else if (cats.some((c) => c.includes('tools') || c.includes('instruments') || c.includes('gaming'))) item.kind = 'tool';
    else if (cats.includes('adventuring-gear')) item.kind = 'gear';
    if (e.cost) item.cost = `${e.cost.quantity} ${e.cost.unit}`;
    if (e.weight) item.weight = e.weight;
    return item;
  }),
  conditions: conditions.map((c) => ({ index: c.index, name: c.name, description: (c.description ?? (c.desc ?? []).join('\n')) || '' })),
  languages: languages.map((l) => l.name),
  alignments: alignments.filter((a) => a.index !== 'unaligned').map((a) => a.name),
};

// ---- monsters (a separate file: only the DM needs them) ----
const ABIL = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const feet = (v) => Number(String(v ?? '').match(/\d+/)?.[0] ?? 0);
function monsterAction(a) {
  const desc = a.desc ?? a.description ?? '';
  const out = { name: a.name, desc };
  if (typeof a.attack_bonus === 'number') out.attack = a.attack_bonus;
  const dmg = (a.damage ?? []).filter((d) => d.damage_dice).map((d) => ({ dice: d.damage_dice.replace(/\s/g, ''), type: d.damage_type?.name ?? '' }));
  // Extra damage that only applies sometimes ("... damage if the attack roll had Advantage").
  if (dmg.length > 1 && /damage if /i.test(desc)) dmg.slice(1).forEach((d) => (d.conditional = true));
  if (dmg.length) out.damage = dmg;
  const dc = desc.match(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw: DC (\d+)/);
  if (dc) out.dc = { ability: ABIL[dc[1].toLowerCase()], value: Number(dc[2]) };
  const reach = desc.match(/reach (\d+) ft/);
  const range = desc.match(/range (\d+)(?:\/(\d+))? ft/);
  if (reach) out.reach = Number(reach[1]);
  if (range) out.range = { normal: Number(range[1]), ...(range[2] ? { long: Number(range[2]) } : {}) };
  return out;
}
const monsterData = monsters.map((m) => {
  const saves = Object.fromEntries(
    (m.proficiencies ?? []).filter((p) => p.proficiency.index.startsWith('saving-throw-')).map((p) => [p.proficiency.index.replace('saving-throw-', ''), p.value]),
  );
  const skills = (m.proficiencies ?? []).filter((p) => p.proficiency.index.startsWith('skill-')).map((p) => `${p.proficiency.name.replace('Skill: ', '')} +${p.value}`);
  return {
    index: m.index,
    name: m.name,
    size: m.size,
    type: m.type,
    alignment: m.alignment,
    cr: m.challenge_rating,
    xp: m.xp,
    ac: m.armor_class?.[0]?.value ?? 10,
    hp: m.hit_points,
    hitDice: m.hit_points_roll ?? m.hit_dice,
    speed: Object.fromEntries(Object.entries(m.speed ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, feet(v)])),
    abilities: { str: m.strength, dex: m.dexterity, con: m.constitution, int: m.intelligence, wis: m.wisdom, cha: m.charisma },
    saves,
    skills,
    senses: Object.entries(m.senses ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', '),
    languages: m.languages ?? '',
    resistances: (m.damage_resistances ?? []).map(String),
    immunities: (m.damage_immunities ?? []).map(String),
    vulnerabilities: (m.damage_vulnerabilities ?? []).map(String),
    conditionImmunities: (m.condition_immunities ?? []).map((c) => c.name ?? String(c)),
    traits: (m.special_abilities ?? []).map((a) => ({ name: a.name, desc: a.desc ?? '' })),
    actions: (m.actions ?? []).map(monsterAction),
    bonusActions: (m.bonus_actions ?? []).map(monsterAction),
    reactions: (m.reactions ?? []).map((a) => ({ name: a.name, desc: a.desc ?? '' })),
    legendary: (m.legendary_actions ?? []).map((a) => ({ name: a.name, desc: a.desc ?? '' })),
  };
});
const MONSTERS_OUT = new URL('../client/src/rules/monsters-2024.json', import.meta.url);
await writeFile(MONSTERS_OUT, JSON.stringify({ source: data.source, monsters: monsterData }));
console.log(`Wrote ${MONSTERS_OUT.pathname} (${(JSON.stringify(monsterData).length / 1024).toFixed(0)} KB): ${monsterData.length} monsters`);

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data));
const kb = (JSON.stringify(data).length / 1024).toFixed(0);
console.log(`Wrote ${OUT.pathname} (${kb} KB): ${data.classes.length} classes, ${data.species.length} species, ${data.backgrounds.length} backgrounds, ${data.spells.length} spells, ${data.items.length} items`);
