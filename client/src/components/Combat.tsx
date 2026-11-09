import { useEffect, useMemo, useState } from 'react';
import type { DiceRoll, RoomState, Token, TokenStats } from '../../../shared/protocol.ts';
import { ABILITIES, ABILITY_NAMES, mod, type Ability, type RulesData, type RulesMonster } from '../../../shared/rules.ts';
import { TOKEN_RADIUS, dist, inRange, type Point } from '../../../shared/geometry.ts';
import type { GameStore } from '../game.ts';
import { formatDistance, useSettings } from '../settings.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "1d8+3 slashing" -> dice, bonus and type. */
export function parseDamageText(text: string) {
  const dice = [...text.matchAll(/(\d+)d(\d+)/g)].map((m) => ({ count: Number(m[1]), sides: Number(m[2]) }));
  const bonus = Number(text.match(/d\d+\s*([+-−]\s*\d+)/)?.[1]?.replace('−', '-').replace(/\s/g, '') ?? 0);
  const type = text.match(/[a-zA-Z]+\s*$/)?.[0] ?? '';
  return { dice, bonus, type };
}

/** Whose turn it is, and helpers about the running fight. */
export function combatInfo(state: RoomState) {
  const c = state.combat;
  const current = c && c.round > 0 ? state.tokens.find((t) => t.id === c.order[c.turn]?.tokenId) ?? null : null;
  return {
    combat: c,
    current,
    movedFt: (t: Token) => (c && current?.id === t.id ? (c.moved[t.id] ?? 0) : 0),
    used: (t: Token) => c?.used[t.id] ?? {},
  };
}

/** A token's hit points: its character's, or its own (monsters). */
export function hpOfToken(state: RoomState, t: Token) {
  const ch = t.characterId ? state.characters.find((c) => c.id === t.characterId) : undefined;
  return ch?.hp ?? t.stats?.hp ?? null;
}

let monstersLoading: Promise<RulesMonster[]> | null = null;
export function useMonsters(): RulesMonster[] | null {
  const [list, setList] = useState<RulesMonster[] | null>(null);
  useEffect(() => {
    monstersLoading ??= import('../rules/monsters-2024.json').then((m) => (m.default as unknown as { monsters: RulesMonster[] }).monsters);
    monstersLoading.then(setList);
  }, []);
  return list;
}

/** Token numbers for a monster from the rules. */
export function monsterStats(m: RulesMonster): TokenStats {
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, m.saves[a] ?? mod(m.abilities[a])])) as Record<Ability, number>;
  return {
    hp: { current: m.hp, max: m.hp, temp: 0 },
    ac: m.ac,
    saves,
    initiative: mod(m.abilities.dex),
    resistances: m.resistances,
    immunities: m.immunities,
    vulnerabilities: m.vulnerabilities,
    monster: m.index,
  };
}

// ---------------------------------------------------------------------------
// Targeting: choose an attack or spell, then tap who it's aimed at
// ---------------------------------------------------------------------------

export type Pending =
  | {
      kind: 'attack';
      attackerId: string;
      label: string;
      toHit: number;
      damage: string; // "1d8+3 slashing"
      extra?: { count: number; sides: number; type: string }[];
      rangeFt: number;
      longFt?: number;
    }
  | { kind: 'save'; attackerId: string; label: string; ability: Ability; dc: number; damage: string; half: boolean; rangeFt: number };

export function useTargeting(store: GameStore, state: RoomState) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<DiceRoll | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 7000);
    return () => clearTimeout(t);
  }, [result]);

  function start(p: Pending) {
    setError(null);
    setPending(p);
    store
      .request('highlight:set', { highlight: { tokenId: p.attackerId, kind: p.kind === 'save' ? 'spell' : 'range', feet: p.rangeFt, label: p.label, ...(p.kind === 'attack' && p.longFt ? { longFeet: p.longFt } : {}) } })
      .catch(() => {});
  }

  function cancel() {
    setPending(null);
    setError(null);
    store.request('highlight:set', { highlight: null }).catch(() => {});
  }

  /** Called with the point tapped on the map: picks the token there. */
  async function tap(at: Point) {
    if (!pending) return;
    const target = state.tokens.find((t) => dist(t, at) <= TOKEN_RADIUS + 0.1 && t.id !== pending.attackerId);
    if (!target) return setError('Tap the creature you want to target.');
    const attacker = state.tokens.find((t) => t.id === pending.attackerId);
    if (attacker && !inRange(attacker, target, pending.kind === 'attack' ? (pending.longFt ?? pending.rangeFt) : pending.rangeFt)) {
      return setError(`${target.name} is out of range.`);
    }
    try {
      const d = parseDamageText(pending.damage);
      const { roll } =
        pending.kind === 'attack'
          ? await store.request('combat:attack', {
              attackerId: pending.attackerId,
              targetId: target.id,
              label: pending.label,
              toHit: pending.toHit,
              damage: d.dice,
              damageBonus: d.bonus,
              damageType: d.type,
              ...(pending.extra ? { extra: pending.extra } : {}),
            })
          : await store.request('combat:save', {
              attackerId: pending.attackerId,
              targetIds: [target.id],
              label: pending.label,
              ability: pending.ability,
              dc: pending.dc,
              damage: d.dice,
              damageBonus: d.bonus,
              damageType: d.type,
              half: pending.half,
            });
      setResult(roll);
      cancel();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { pending, result, error, start, cancel, tap, clearResult: () => setResult(null) };
}

/** While choosing a target: what's being done, and Cancel. Afterwards: what happened. */
export function TargetBar({ targeting }: { targeting: ReturnType<typeof useTargeting> }) {
  const { pending, error } = targeting;
  if (!pending) return null;
  return (
    <div className="aim-bar" data-testid="target-bar">
      <div className="grow">
        <strong className="attack-label">{pending.label}</strong>
        <div className="hint">
          {pending.kind === 'attack' ? `${pending.toHit >= 0 ? '+' : ''}${pending.toHit} to hit · ${pending.damage}` : `DC ${pending.dc} ${pending.ability.toUpperCase()} save · ${pending.damage || 'no damage'}`}
          . Tap the target on the map.
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <button className="button small" onClick={targeting.cancel}>Cancel</button>
    </div>
  );
}

export function RollResult({ roll, onClose }: { roll: DiceRoll | null; onClose: () => void }) {
  if (!roll) return null;
  return (
    <div className="roll-toast result" onClick={onClose} data-testid="attack-result">
      <div>
        <div className="hint">{roll.label}</div>
        {roll.outcomes?.map((o, i) => (
          <div key={i}>
            <strong>{o.target}</strong>: {outcomeText(o.result)}
            {o.damage > 0 ? `, ${o.damage} damage` : ''}
            {o.note ? ` (${o.note})` : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

export function outcomeText(r: string) {
  return { hit: 'hit', crit: 'critical hit!', miss: 'miss', saved: 'saved', failed: 'failed the save' }[r] ?? r;
}

// ---------------------------------------------------------------------------
// Player: the combat bar on the phone
// ---------------------------------------------------------------------------

export function CombatBar({ store, state, token }: { store: GameStore; state: RoomState; token: Token | null }) {
  const { unit } = useSettings();
  const { combat, current, movedFt, used } = combatInfo(state);
  const [error, setError] = useState<string | null>(null);
  if (!combat) return null;
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const mine = token ? combat.order.find((e) => e.tokenId === token.id) : undefined;
  const myTurn = !!token && current?.id === token.id;
  const u = token ? used(token) : {};
  const ch = token?.characterId ? state.characters.find((c) => c.id === token.characterId) : undefined;
  const speed = (ch?.summary.speedFt ?? token?.speedFt ?? 30) * (u.dash ? 2 : 1);
  const left = token ? Math.max(0, speed - movedFt(token)) : 0;
  const toggle = (what: 'action' | 'bonus' | 'reaction' | 'dash') => token && run(store.request('combat:use', { tokenId: token.id, what, value: !u[what] }));

  return (
    <div className={`combat-bar ${myTurn ? 'my-turn' : ''}`} data-testid="combat-bar">
      {combat.round === 0 ? (
        <div className="row">
          <strong className="grow">Roll for initiative!</strong>
          {mine && mine.init === null && (
            <button className="button small primary important-red" onClick={() => token && run(store.request('combat:initiative', { tokenId: token.id }))} data-testid="roll-initiative">
              Roll initiative
            </button>
          )}
          {mine && mine.init !== null && <span>You rolled {mine.init}</span>}
        </div>
      ) : myTurn ? (
        <>
          <div className="row">
            <strong className="grow">Your turn · round {combat.round}</strong>
            <span className="hint">{formatDistance(left, unit)} left</span>
          </div>
          <div className="chip-row">
            {(['action', 'bonus', 'reaction', 'dash'] as const).map((w) => (
              <button key={w} className={`chip ${u[w] ? 'used' : ''}`} onClick={() => toggle(w)} aria-pressed={!!u[w]}>
                {{ action: 'Action', bonus: 'Bonus action', reaction: 'Reaction', dash: 'Dash' }[w]}
                {u[w] ? ' ✓' : ''}
              </button>
            ))}
            <button className="button small primary" onClick={() => run(store.request('combat:next', {}))} data-testid="end-turn">
              End turn
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <span className="grow">
            Round {combat.round} · <strong>{current?.name ?? '…'}</strong>'s turn
          </span>
          {token && u.reaction ? <span className="hint">Reaction used</span> : null}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Screen: the initiative order along the edges
// ---------------------------------------------------------------------------

export function InitiativeBar({ state }: { state: RoomState }) {
  const { combat, current } = combatInfo(state);
  if (!combat) return null;
  const order = combat.order.map((e) => ({ ...e, token: state.tokens.find((t) => t.id === e.tokenId) })).filter((e) => e.token);
  const bar = (
    <div className="initiative-bar" data-testid="initiative-bar">
      <span className="round">{combat.round === 0 ? 'Roll initiative' : `Round ${combat.round}`}</span>
      {order.map((e) => (
        <span key={e.tokenId} className={`init-chip ${current?.id === e.tokenId ? 'current' : ''} ${(e.token!.conditions ?? []).includes('unconscious') ? 'down' : ''}`}>
          <span className="badge-dot" style={{ background: e.token!.color }} />
          {e.token!.name}
          <span className="init">{e.init ?? '–'}</span>
        </span>
      ))}
    </div>
  );
  // Shown at the bottom and (upside down) at the top, for players on both sides of the table.
  return (
    <>
      <div className="initiative-edge bottom">{bar}</div>
      <div className="initiative-edge top">{bar}</div>
    </>
  );
}

// ---------------------------------------------------------------------------
// DM: running the fight
// ---------------------------------------------------------------------------

export function CombatPanel({ store, state, onSelect }: { store: GameStore; state: RoomState; onSelect: (id: string) => void }) {
  const { combat, current } = combatInfo(state);
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const [chosen, setChosen] = useState<string[]>(() => state.tokens.map((t) => t.id));

  if (!combat) {
    return (
      <div className="stack-sm" data-testid="combat-panel">
        <p className="hint">Who is in the fight? Monsters and NPCs roll initiative at once; players roll on their phones.</p>
        <div className="pill-grid">
          {state.tokens.map((t) => (
            <button key={t.id} className={`pill ${chosen.includes(t.id) ? 'prof on' : ''}`} onClick={() => setChosen(chosen.includes(t.id) ? chosen.filter((x) => x !== t.id) : [...chosen, t.id])}>
              {t.name}
            </button>
          ))}
        </div>
        <button className="button primary block important-red" disabled={!chosen.length} onClick={() => run(store.request('combat:start', { tokenIds: chosen }))} data-testid="start-combat">
          Roll for initiative!
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="stack-sm" data-testid="combat-panel">
      <div className="row">
        <strong className="grow">{combat.round === 0 ? 'Rolling initiative' : `Round ${combat.round}: ${current?.name}'s turn`}</strong>
        {combat.round === 0 ? (
          <button className="button small primary" onClick={() => run(store.request('combat:begin', {}))} data-testid="begin-combat">
            Begin
          </button>
        ) : (
          <button className="button small primary" onClick={() => run(store.request('combat:next', {}))} data-testid="next-turn">
            Next turn
          </button>
        )}
        <button className="button small" onClick={() => confirm('End the fight?') && run(store.request('combat:end', {}))}>End fight</button>
      </div>
      <ul className="list compact">
        {combat.order.map((e) => {
          const t = state.tokens.find((x) => x.id === e.tokenId);
          if (!t) return null;
          const hp = hpOfToken(state, t);
          return (
            <li key={e.tokenId} className={current?.id === t.id ? 'current-row' : ''}>
              <input
                className="qty"
                type="number"
                value={e.init ?? ''}
                placeholder="–"
                onChange={(ev) => ev.target.value !== '' && run(store.request('combat:initiative', { tokenId: t.id, value: Number(ev.target.value) }))}
                aria-label={`Initiative for ${t.name}`}
              />
              <button className="link grow" onClick={() => onSelect(t.id)}>
                {t.name}
              </button>
              {hp && (
                <span className={`hint ${hp.current === 0 ? 'down-text' : ''}`}>
                  {hp.current}/{hp.max} HP
                </span>
              )}
              {e.init === null && (
                <button className="button small" onClick={() => run(store.request('combat:initiative', { tokenId: t.id }))}>Roll</button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** HP and conditions of a token (DM: any; player: their own). */
export function TokenStatus({ store, state, token, rules }: { store: GameStore; state: RoomState; token: Token; rules: RulesData | null }) {
  const hp = hpOfToken(state, token);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const conditions = token.conditions ?? [];
  const change = (sign: number) => {
    const n = Math.abs(parseInt(amount, 10));
    if (!n) return;
    run(store.request('token:hp', { tokenId: token.id, change: sign * n }));
    setAmount('');
  };
  return (
    <div className="token-status">
      {hp && (
        <div className="row">
          <span className="grow">
            <strong data-testid="token-hp">{hp.current}</strong> / {hp.max} HP{hp.temp ? ` (+${hp.temp})` : ''}
          </span>
          <input className="qty" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="0" aria-label="HP amount" />
          <button className="button small" onClick={() => change(-1)}>Damage</button>
          <button className="button small" onClick={() => change(1)}>Heal</button>
        </div>
      )}
      <div className="pill-grid conditions">
        {(rules?.conditions ?? []).map((c) => {
          const on = conditions.includes(c.index);
          return (
            <button
              key={c.index}
              className={`pill ${on ? 'prof on condition-on' : ''}`}
              title={c.description.replace(/\*\*/g, '')}
              onClick={() => run(store.request('token:conditions', { tokenId: token.id, conditions: on ? conditions.filter((x) => x !== c.index) : [...conditions, c.index] }))}
            >
              {c.name}
            </button>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** A monster's stat block, with buttons to attack a target. */
export function MonsterBlock({ monster, token, targeting }: { monster: RulesMonster; token: Token; targeting: ReturnType<typeof useTargeting> }) {
  const { unit } = useSettings();
  const actions = [...monster.actions, ...monster.bonusActions];
  return (
    <div className="monster-block" data-testid="monster-block">
      <div className="hint">
        {monster.size} {monster.type}, {monster.alignment} · CR {monster.cr} · AC {monster.ac} · speed{' '}
        {Object.entries(monster.speed).map(([k, v]) => `${k === 'walk' ? '' : `${k} `}${formatDistance(v, unit)}`).join(', ')}
      </div>
      <div className="monster-abilities">
        {ABILITIES.map((a) => (
          <span key={a}>
            <span className="field-label">{a}</span> {monster.abilities[a]} ({mod(monster.abilities[a]) >= 0 ? '+' : ''}
            {mod(monster.abilities[a])})
          </span>
        ))}
      </div>
      {monster.senses && <div className="hint">{monster.senses}</div>}
      {[...monster.resistances.map((r) => `resists ${r}`), ...monster.immunities.map((r) => `immune to ${r}`)].length > 0 && (
        <div className="hint">{[...monster.resistances.map((r) => `resists ${r}`), ...monster.immunities.map((r) => `immune to ${r}`)].join(' · ')}</div>
      )}
      {monster.traits.map((t) => (
        <p key={t.name} className="prose">
          <strong>{t.name}.</strong> {t.desc}
        </p>
      ))}
      {actions.map((a) => {
        const main = a.damage?.[0];
        const extra = a.damage?.slice(1).filter((d) => !d.conditional).map((d) => ({ ...parseDamageText(d.dice).dice[0], type: d.type }));
        return (
          <div key={a.name} className="monster-action">
            <p className="prose">
              <strong>{a.name}.</strong> {a.desc}
            </p>
            {a.attack !== undefined && main && (
              <button
                className="button small important-red"
                onClick={() =>
                  targeting.start({
                    kind: 'attack',
                    attackerId: token.id,
                    label: a.name,
                    toHit: a.attack!,
                    damage: `${main.dice} ${main.type}`,
                    extra: extra?.filter((x) => x.count),
                    rangeFt: a.range?.normal ?? a.reach ?? 5,
                    longFt: a.range?.long,
                  })
                }
              >
                Attack with {a.name}
              </button>
            )}
            {a.dc && (
              <button
                className="button small important-red"
                onClick={() =>
                  targeting.start({
                    kind: 'save',
                    attackerId: token.id,
                    label: a.name,
                    ability: a.dc!.ability,
                    dc: a.dc!.value,
                    damage: main ? `${main.dice} ${main.type}` : '',
                    half: /half as much/i.test(a.desc),
                    rangeFt: a.range?.normal ?? a.reach ?? 60,
                  })
                }
              >
                {a.name}: DC {a.dc.value} {ABILITY_NAMES[a.dc.ability]} save
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Find a monster from the rules and put it on the map. */
export function MonsterPicker({ store, onAdded }: { store: GameStore; onAdded: (id: string) => void }) {
  const monsters = useMonsters();
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const matches = useMemo(
    () => (monsters && query.length >= 2 ? monsters.filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8) : []),
    [monsters, query],
  );

  async function add(m: RulesMonster) {
    try {
      let last = '';
      for (let i = 1; i <= count; i++) {
        const { tokenId } = await store.request('token:add', {
          name: count > 1 ? `${m.name} ${i}` : m.name,
          kind: 'monster',
          color: '#4d4d4d',
          stats: monsterStats(m),
          speedFt: m.speed.walk ?? 30,
        });
        last = tokenId;
      }
      onAdded(last);
      setQuery('');
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack-sm">
      <div className="inline-form">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={monsters ? 'Search 341 monsters, e.g. goblin' : 'Loading monsters…'} aria-label="Search monsters" />
        <input className="qty" type="number" min={1} max={12} value={count} onChange={(e) => setCount(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} aria-label="How many" />
      </div>
      <ul className="list compact">
        {matches.map((m) => (
          <li key={m.index}>
            <span className="grow">
              <strong>{m.name}</strong> <span className="hint">CR {m.cr} · AC {m.ac} · {m.hp} HP</span>
            </span>
            <button className="button small" onClick={() => add(m)}>Add{count > 1 ? ` ${count}` : ''}</button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
