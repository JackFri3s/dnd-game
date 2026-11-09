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

const [classes, levels, species, subspecies, backgrounds, feats, skills, spells, equipment, traits, features, languages, alignments] =
  await Promise.all(
    ['Classes', 'Levels', 'Species', 'Subspecies', 'Backgrounds', 'Feats', 'Skills', 'Spells', 'Equipment', 'Traits', 'Features', 'Languages', 'Alignments'].map(load),
  );

const skillIndex = (profIndex) => profIndex.replace(/^skill-/, '');

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
    size: s.size,
    speed: s.speed,
    traits: s.traits.map((t) => t.index),
    subspecies: (s.subspecies ?? []).map((ref) => {
      const sub = subspecies.find((x) => x.index === ref.index);
      return { index: ref.index, name: ref.name, traits: (sub?.traits ?? []).map((t) => t.index) };
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
  feats: feats.map((f) => ({ index: f.index, name: f.name, description: f.description ?? '' })),
  traits: traits.map((t) => ({ index: t.index, name: t.name, description: t.description ?? '' })),
  features: features
    .filter((f) => !f.subclass)
    .map((f) => ({ index: f.index, name: f.name, class: f.class?.index ?? '', level: f.level?.index ? Number(f.level.index.split('-').pop()) : 1, description: f.description ?? '' })),
  spells: spells.map((s) => ({
    index: s.index,
    name: s.name,
    level: s.level,
    school: s.school?.name ?? '',
    classes: (s.classes ?? []).map((c) => c.index),
    castingTime: s.casting_time ?? '',
    range: s.range ?? '',
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
        damage: e.damage.damage_dice,
        type: e.damage.damage_type?.name ?? '',
        properties: (e.properties ?? []).map((p) => p.name),
        ranged: cats.includes('ranged-weapons'),
      };
      if (e.range?.normal) item.weapon.range = { normal: e.range.normal, ...(e.range.long ? { long: e.range.long } : {}) };
    } else if (e.contents) {
      item.kind = 'pack';
      item.contents = e.contents.map((c) => ({ index: c.item.index, name: c.item.name, qty: c.quantity }));
    } else if (cats.some((c) => c.includes('tools') || c.includes('instruments') || c.includes('gaming'))) item.kind = 'tool';
    else if (cats.includes('adventuring-gear')) item.kind = 'gear';
    if (e.cost) item.cost = `${e.cost.quantity} ${e.cost.unit}`;
    if (e.weight) item.weight = e.weight;
    return item;
  }),
  languages: languages.map((l) => l.name),
  alignments: alignments.filter((a) => a.index !== 'unaligned').map((a) => a.name),
};

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(data));
const kb = (JSON.stringify(data).length / 1024).toFixed(0);
console.log(`Wrote ${OUT.pathname} (${kb} KB): ${data.classes.length} classes, ${data.species.length} species, ${data.backgrounds.length} backgrounds, ${data.spells.length} spells, ${data.items.length} items`);
