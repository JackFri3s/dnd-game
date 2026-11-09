// Seeded randomness and name lists for the generators.
// The same seed always gives the same village, building or cave.

export type Rng = {
  (): number; // 0 <= n < 1
  int(min: number, max: number): number; // inclusive
  pick<T>(list: readonly T[]): T;
  chance(p: number): boolean;
  shuffle<T>(list: T[]): T[];
  range(min: number, max: number): number;
};

export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 1;
  const next = (() => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  next.pick = (list) => list[Math.floor(next() * list.length)];
  next.chance = (p) => next() < p;
  next.range = (min, max) => min + next() * (max - min);
  next.shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  return next;
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

// ---------------------------------------------------------------------------
// Names (original lists)
// ---------------------------------------------------------------------------

const PLACE_START = ['Brindle', 'Oak', 'Ash', 'Raven', 'Mill', 'Stone', 'Willow', 'Thorn', 'Elder', 'Green', 'Cold', 'High', 'Fen', 'Briar', 'Hollow', 'Amber', 'Grey', 'Black', 'Silver', 'Wolf', 'Bramble', 'Kings', 'Marsh', 'Red', 'Long', 'Fox', 'Heron', 'Moss'];
const PLACE_END = ['moor', 'ford', 'wick', 'ton', 'dale', 'brook', 'vale', 'stead', 'mere', 'holt', 'bury', 'hollow', 'cross', 'field', 'well', 'gate', 'by', 'combe'];
export const placeName = (r: Rng) => r.pick(PLACE_START) + r.pick(PLACE_END);

const INN_ADJ = ['Gilded', 'Prancing', 'Sleeping', 'Drunken', 'Rusty', 'Laughing', 'Silver', 'Crooked', 'Wandering', 'Golden', 'Hungry', 'Lucky', 'Weary', 'Merry', 'Green'];
const INN_NOUN = ['Tankard', 'Pony', 'Dragon', 'Goose', 'Lantern', 'Boar', 'Stag', 'Kettle', 'Anchor', 'Barrel', 'Owl', 'Griffin', 'Fiddle', 'Hearth', 'Mermaid'];
export const innName = (r: Rng) => `The ${r.pick(INN_ADJ)} ${r.pick(INN_NOUN)}`;

const FIRST = [
  'Alda', 'Bram', 'Cora', 'Dain', 'Edda', 'Finn', 'Greta', 'Hal', 'Ilse', 'Jory', 'Kesta', 'Lom', 'Maren', 'Nils', 'Orla', 'Pell', 'Quin', 'Rhea', 'Soren', 'Tilda',
  'Ulric', 'Vera', 'Wim', 'Ysolde', 'Arn', 'Bets', 'Cobb', 'Dora', 'Elric', 'Fen', 'Gwen', 'Hob', 'Ida', 'Jasper', 'Kit', 'Lark', 'Milo', 'Nan', 'Osric', 'Pip',
  'Rowan', 'Sela', 'Tam', 'Una', 'Vic', 'Wren', 'Yara', 'Zed', 'Torva', 'Mirabel',
];
const SURNAME = [
  'Smith', 'Miller', 'Thatcher', 'Cooper', 'Fletcher', 'Brewer', 'Ashdown', 'Hale', 'Marsh', 'Underhill', 'Barley', 'Tanner', 'Wainwright', 'Holt', 'Reed',
  'Fairweather', 'Stone', 'Brook', 'Greaves', 'Pike', 'Crane', 'Dunmore', 'Mossgrave', 'Hobb', 'Kettleby',
];
export const personName = (r: Rng) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`;

export const PERSONALITY = [
  'cheerful and talks too much', 'suspicious of strangers', 'tired and short-tempered', 'kind but nosy', 'proud of their work', 'nervous, keeps looking over their shoulder',
  'a terrible liar', 'quietly religious', 'loves a good bargain', 'gruff but fair', 'dreamy and forgetful', 'boastful about a past adventure', 'grieving someone recently lost',
  'secretly brave', 'loyal to the village elder', 'always hungry', 'superstitious about everything', 'bored and looking for excitement',
];
export const LOOK = [
  'flour on their sleeves', 'a missing front tooth', 'a bright red scarf', 'soot-stained hands', 'a nervous twitch', 'braided grey hair', 'an old scar across the cheek',
  'muddy boots', 'a very tall hat', 'a limp from an old injury', 'ink-stained fingers', 'a pet crow on the shoulder', 'freckles everywhere', 'a booming laugh',
];
export const SECRET = [
  'owes money to someone dangerous', 'saw something strange near the old well', 'is hiding a relative wanted by the law', 'knows where a treasure was buried',
  'is a spy for a distant lord', 'stole from the temple years ago', 'has a map to a forgotten cave', 'is in love with someone they should not be', 'heard voices in the woods at night',
  'secretly worships an old god', 'has nothing to hide', 'has nothing to hide', 'knows a shortcut through the hills',
];
