import { useEffect, useMemo, useState } from 'react';
import type { RulesData } from '../../../shared/rules.ts';
import { mergeHomebrew, type Homebrew } from '../../../shared/homebrew.ts';

// The rules data (~500 KB) is only downloaded when a character screen first needs it.
let loading: Promise<RulesData> | null = null;
let loaded: RulesData | null = null;

export function loadRules(): Promise<RulesData> {
  loading ??= import('./srd-2024.json').then((m) => (loaded = m.default as unknown as RulesData));
  return loading;
}

/** The official rules, plus the campaign's custom content when given. */
export function useRules(homebrew?: Homebrew): RulesData | null {
  const [rules, setRules] = useState(loaded);
  useEffect(() => {
    if (!rules) loadRules().then(setRules);
  }, [rules]);
  return useMemo(() => (rules ? mergeHomebrew(rules, homebrew) : null), [rules, homebrew]);
}

/** Standard languages a character can pick from (the others are rare languages). */
export const STANDARD_LANGUAGES = ['Common Sign Language', 'Draconic', 'Dwarvish', 'Elvish', 'Giant', 'Gnomish', 'Goblin', 'Halfling', 'Orc'];

/** Short descriptions of the classes, to help new players choose. */
export const CLASS_BLURBS: Record<string, string> = {
  barbarian: 'A fierce warrior who fights with raw strength and rage. Tough and simple to play.',
  bard: 'A performer whose music and words work magic. Supports friends, talks their way through.',
  cleric: 'A priest who channels divine power: heals allies, protects, and smites foes.',
  druid: 'A keeper of nature who casts nature magic and can take the shape of animals.',
  fighter: 'A master of weapons and armour. Reliable in every fight; great first character.',
  monk: 'A quick martial artist who fights unarmed and moves with supernatural speed.',
  paladin: 'A holy knight in heavy armour, combining sword and divine magic.',
  ranger: 'A hunter and scout, deadly with a bow, at home in the wild, with some nature magic.',
  rogue: 'A sneaky expert: picks locks, finds traps, and strikes where it hurts most.',
  sorcerer: 'A spellcaster whose magic is in their blood. Fewer spells, but more flexible.',
  warlock: 'A caster who made a pact with a powerful being. Few but strong spells.',
  wizard: 'A scholar of magic with the largest choice of spells, learned from a spellbook.',
};

const SYLLABLES = {
  start: ['Ae', 'Bra', 'Cor', 'Da', 'El', 'Fen', 'Gar', 'Hal', 'Is', 'Jor', 'Ka', 'Lir', 'Mor', 'Ny', 'Or', 'Per', 'Quel', 'Ro', 'Sa', 'Tor', 'Ul', 'Vae', 'Wyn', 'Yse', 'Zan'],
  middle: ['', '', 'a', 'e', 'i', 'o', 'ri', 'la', 'ven', 'dor', 'th', 'mi'],
  end: ['n', 'ra', 'wyn', 'mir', 'dor', 'ric', 'lis', 'th', 'na', 'gar', 'sha', 'en', 'is', 'ul', 'ia'],
};

/** A random fantasy name, for players who can't think of one. */
export function randomName() {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return pick(SYLLABLES.start) + pick(SYLLABLES.middle) + pick(SYLLABLES.end);
}
