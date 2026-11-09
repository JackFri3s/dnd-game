import { useState } from 'react';
import type { Area, Highlight, RoomState, Token } from '../../../shared/protocol.ts';
import { areaGeometry, describeArea, dist, fromCaster, inRange, touchesArea, type AreaSpec, type Point } from '../../../shared/geometry.ts';
import { derive, spellDiceAt, withSummary, type Ability, type AreaShape, type Character, type RulesData, type RulesSpell } from '../../../shared/rules.ts';
import { parseDamageText, type useTargeting } from './Combat.tsx';
import type { GameStore } from '../game.ts';
import { formatDistance, useSettings } from '../settings.ts';
import type { AreaPreview } from './MapBoard.tsx';

// ---------------------------------------------------------------------------
// Highlights are private first: shown on your own screen, then (if you like) on the table.
// ---------------------------------------------------------------------------

export function useLocalHighlight() {
  const [local, setLocal] = useState<Highlight | null>(null);
  return { local, setLocal };
}
export type LocalHighlight = ReturnType<typeof useLocalHighlight>;

/** Spell slots a character can still use for a spell of `level` (1-9). */
export function freeSlotLevels(character: Character | null, rules: RulesData | null, level: number): number[] {
  if (!character || !rules || level < 1) return [];
  const slots = rules.classes.find((c) => c.index === character.classIndex)?.levels.find((l) => l.level === character.level)?.slots ?? [];
  return slots.map((n, i) => (i + 1 >= level && n > (character.spellSlotsUsed[i] ?? 0) ? i + 1 : 0)).filter(Boolean);
}

/** Marks one spell slot of `slotLevel` as used. */
export async function spendSlot(store: GameStore, character: Character, rules: RulesData, slotLevel: number) {
  const used = [...character.spellSlotsUsed];
  used[slotLevel - 1] = (used[slotLevel - 1] ?? 0) + 1;
  await store.request('character:save', { character: withSummary({ ...character, spellSlotsUsed: used }, rules) });
}

/** A spell or effect being aimed on the map. */
export interface Aim {
  label: string;
  spec: AreaSpec;
  rangeFt: number | null;
  tokenId: string;
  spell?: RulesSpell; // for higher-level casting and concentration
  spellLevel: number; // 0 = cantrip / no slot
  slotLevel: number; // the slot it will be cast with
  target: Point | null;
  /** Spells that ask for a saving throw: everyone in the area rolls when it's cast. */
  save?: { ability: Ability; dc: number; damage: string; half: boolean; condition?: string };
}

/** Everything a page needs to aim and cast an area. */
export function useAim(store: GameStore, state: RoomState, highlight: LocalHighlight) {
  const [aim, setAim] = useState<Aim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = aim ? state.tokens.find((t) => t.id === aim.tokenId) : undefined;

  const preview: AreaPreview | null =
    aim && token && aim.target
      ? {
          tokenId: token.id,
          label: aim.label,
          shape: aim.spec.shape,
          sizeFt: aim.spec.sizeFt,
          widthFt: aim.spec.widthFt,
          rangeFt: aim.rangeFt,
          origin: { x: token.x, y: token.y },
          target: aim.target,
        }
      : null;

  function tapMap(at: Point) {
    if (!aim || !token) return;
    const self = fromCaster(aim.spec, aim.rangeFt);
    if (!self && aim.rangeFt !== null && !inRange(token, at, aim.rangeFt) && dist(token, at) > 0.5) {
      setError('That is out of range.');
      return;
    }
    if (self && dist(token, at) < 0.2) return;
    setError(null);
    setAim({ ...aim, target: at });
  }

  function start(next: Omit<Aim, 'target' | 'slotLevel'> & { slotLevel?: number }) {
    setError(null);
    setAim({ ...next, slotLevel: next.slotLevel ?? next.spellLevel, target: null });
    // Show the spell's range on this screen while aiming.
    if (next.rangeFt && !fromCaster(next.spec, next.rangeFt)) highlight.setLocal({ tokenId: next.tokenId, kind: 'spell', feet: next.rangeFt, label: next.label });
  }

  function cancel() {
    setAim(null);
    setError(null);
    highlight.setLocal(null);
  }

  async function cast(character: Character | null, rules: RulesData | null) {
    if (!preview || !aim) return;
    try {
      const { areaId } = { areaId: (await store.request('area:add', { area: preview })).id };
      const charLevel = character?.level ?? 1;
      const damage = aim.spell ? spellDiceAt(aim.spell, aim.slotLevel, charLevel) : (aim.save?.damage ?? '');
      // Everyone (partly) inside the area makes the saving throw; damage and conditions are applied.
      if (aim.save) {
        const g = areaGeometry(aim.spec, preview.origin, preview.target, aim.rangeFt);
        const targetIds = state.tokens.filter((t) => touchesArea(g, t) && (t.id !== aim.tokenId || !fromCaster(aim.spec, aim.rangeFt))).map((t) => t.id);
        const d = parseDamageText(damage);
        await store.request('combat:save', {
          attackerId: aim.tokenId,
          targetIds,
          label: aim.label,
          ability: aim.save.ability,
          dc: aim.save.dc,
          damage: d.dice,
          damageBonus: d.bonus,
          damageType: d.type,
          half: aim.save.half,
          ...(aim.save.condition ? { condition: aim.save.condition } : {}),
          ...(aim.spell?.concentration ? { concentration: aim.label, areaId } : {}),
        });
      } else if (aim.spell?.concentration) {
        await store.request('combat:concentrate', { tokenId: aim.tokenId, spell: aim.label, areaId });
      }
      if (character && rules && aim.spellLevel > 0 && freeSlotLevels(character, rules, aim.slotLevel).includes(aim.slotLevel)) {
        await spendSlot(store, character, rules, aim.slotLevel);
      }
      cancel();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { aim, preview, error, tapMap, start, cancel, cast, setSlotLevel: (n: number) => aim && setAim({ ...aim, slotLevel: n }) };
}

/** Choose the spell slot to cast with (higher slots make many spells stronger). */
export function SlotPicker({ levels, value, onChange }: { levels: number[]; value: number; onChange: (n: number) => void }) {
  if (levels.length <= 1) return null;
  return (
    <label className="inline-label slot-picker">
      Cast with
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label="Spell slot level">
        {levels.map((l) => (
          <option key={l} value={l}>
            a level {l} slot
          </option>
        ))}
      </select>
    </label>
  );
}

/** The bar shown while aiming: what is being cast, the slot, and Cast / Cancel. */
export function AimBar({ aimState, character, rules }: { aimState: ReturnType<typeof useAim>; character: Character | null; rules: RulesData | null }) {
  const { unit } = useSettings();
  const { aim, preview, error } = aimState;
  if (!aim) return null;
  const self = fromCaster(aim.spec, aim.rangeFt);
  const levels = freeSlotLevels(character, rules, aim.spellLevel);
  const damage = aim.spell ? spellDiceAt(aim.spell, aim.slotLevel, character?.level ?? 1) : aim.save?.damage;
  return (
    <div className="action-bar spell" data-testid="aim-bar">
      <div className="action-bar-title">
        <strong>{aim.label}</strong>
        <span className="hint">
          {describeArea(aim.spec, (ft) => formatDistance(ft, unit))}
          {damage ? ` · ${damage}` : ''}
          {aim.save ? ` · DC ${aim.save.dc} ${aim.save.ability.toUpperCase()} save` : ''}
          {aim.spell?.concentration ? ' · concentration' : ''}
        </span>
      </div>
      <p className="hint">
        {preview ? 'Tap somewhere else to move it, or cast it.' : self ? 'Tap the map to point it.' : `Tap a spot within ${aim.rangeFt === null ? 'range' : formatDistance(aim.rangeFt, unit)} to place it.`}
        {aim.spellLevel > 0 && !levels.length ? ' No spell slots left: casting won’t use one.' : ''}
      </p>
      <SlotPicker levels={levels} value={aim.slotLevel} onChange={aimState.setSlotLevel} />
      {error && <p className="error">{error}</p>}
      <div className="button-row">
        <button className="button" onClick={aimState.cancel}>Cancel</button>
        <button className="button primary important" disabled={!preview} onClick={() => aimState.cast(character, rules)} data-testid="cast">
          Cast {aim.label}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The action panel
// ---------------------------------------------------------------------------

const GENERIC_RANGES = [30, 60, 120];
const SHAPES: { shape: AreaShape; label: string; size: number }[] = [
  { shape: 'sphere', label: 'Circle', size: 20 },
  { shape: 'cone', label: 'Cone', size: 15 },
  { shape: 'line', label: 'Line', size: 60 },
  { shape: 'cube', label: 'Square', size: 15 },
];

type Selected =
  | { kind: 'move' }
  | { kind: 'weapon'; index: number }
  | { kind: 'spell'; index: string }
  | { kind: 'range'; feet: number };

/**
 * What a token can do, as cards: movement, each attack and each spell.
 * Tapping a card shows its range on this screen only; from there it can be
 * shown on the table, or used on a target.
 */
export function ActionPanel({
  store,
  state,
  token,
  character,
  rules,
  aimState,
  canRemoveArea,
  dmTools,
  targeting,
  highlight,
}: {
  store: GameStore;
  state: RoomState;
  token: Token;
  character: Character | null;
  rules: RulesData | null;
  aimState: ReturnType<typeof useAim>;
  canRemoveArea: (a: Area) => boolean;
  /** The DM always gets the general ranges and area shapes, for any token. */
  dmTools?: boolean;
  targeting?: ReturnType<typeof useTargeting>;
  highlight: LocalHighlight;
}) {
  const { unit } = useSettings();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fmt = (ft: number) => formatDistance(ft, unit);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  const d = character && rules ? derive(character, rules) : null;
  const weapons = d ? d.attacks : [];
  const spells =
    character && rules
      ? [...new Set([...character.cantrips, ...character.spells, ...(d?.bonusSpells ?? []).map((b) => b.index)])]
          .map((id) => rules.spells.find((s) => s.index === id))
          .filter((s): s is RulesSpell => !!s)
      : [];
  const spellAbility = (index: string): Ability | null => d?.bonusSpells.find((b) => b.index === index)?.ability ?? d?.spellcasting?.ability ?? null;
  const spellDc = (index: string) => {
    const a = spellAbility(index);
    return a && d ? 8 + d.prof + d.mods[a] : 10;
  };
  const spellAttack = (index: string) => {
    const a = spellAbility(index);
    return a && d ? d.prof + d.mods[a] : 0;
  };
  const halfOnSave = (text: string) => /half as much damage/i.test(text);
  const shared = state.highlight?.tokenId === token.id ? state.highlight : null;
  const sameAsShared = !!shared && !!highlight.local && shared.kind === highlight.local.kind && shared.feet === highlight.local.feet && shared.label === highlight.local.label;
  const areas = state.areas.filter((a) => canRemoveArea(a));
  const rageNumber = d?.classNumbers.find((n) => n.label === 'Rage damage');

  /** Select a card: show its range here (not on the table yet). */
  function select(sel: Selected, h: Highlight | null) {
    setSelected(sel);
    setSlot(null);
    highlight.setLocal(h);
  }
  function close() {
    setSelected(null);
    highlight.setLocal(null);
  }
  function toTable() {
    if (sameAsShared) run(store.request('highlight:set', { highlight: null }));
    else if (highlight.local) run(store.request('highlight:set', { highlight: highlight.local }));
  }

  const weapon = selected?.kind === 'weapon' ? weapons[selected.index] : null;
  const spell = selected?.kind === 'spell' ? spells.find((s) => s.index === selected.index) ?? null : null;
  const slotLevels = spell ? freeSlotLevels(character, rules, spell.level) : [];
  const slotLevel = spell ? (slot ?? slotLevels[0] ?? spell.level) : 0;
  const isMelee = (w: (typeof weapons)[number]) => !w.normalFt || w.reachFt > 0;

  function attackWithWeapon(w: (typeof weapons)[number]) {
    if (!targeting) return;
    if (w.saveAbility && w.dc) {
      aimState.start({ label: w.name, spec: { shape: 'cone', sizeFt: 15 }, rangeFt: 0, tokenId: token.id, spellLevel: 0, save: { ability: w.saveAbility, dc: w.dc, damage: w.damage, half: true } });
      return;
    }
    // Raging: Strength melee attacks deal extra damage.
    const parsed = parseDamageText(w.damage);
    const rage = token.raging && rageNumber && isMelee(w) ? Number(rageNumber.value.replace('+', '')) : 0;
    targeting.start({
      kind: 'attack',
      attackerId: token.id,
      label: w.name,
      toHit: w.toHit,
      damage: rage ? `${parsed.dice.map((x) => `${x.count}d${x.sides}`).join('+')}${parsed.bonus + rage >= 0 ? '+' : ''}${parsed.bonus + rage} ${parsed.type}` : w.damage,
      rangeFt: w.normalFt ?? w.reachFt,
      longFt: w.longFt,
      melee: isMelee(w),
      sneak: d?.classNumbers.find((n) => n.label === 'Sneak Attack')?.value,
    });
  }

  async function castSpell(s: RulesSpell) {
    const conc = s.concentration ? s.name : undefined;
    const damage = spellDiceAt(s, slotLevel, character?.level ?? 1);
    if (s.area) {
      aimState.start({
        label: s.name,
        spec: { shape: s.area.shape, sizeFt: s.area.size, widthFt: s.area.width },
        rangeFt: s.rangeFt,
        tokenId: token.id,
        spell: s,
        spellLevel: s.level,
        slotLevel,
        ...(s.save ? { save: { ability: s.save, dc: spellDc(s.index), damage: s.damage ?? '', half: halfOnSave(s.description), ...(s.condition ? { condition: s.condition } : {}) } } : {}),
      });
      return;
    }
    if (!targeting) return;
    const onCast = async () => {
      if (character && rules && s.level > 0 && slotLevels.includes(slotLevel)) await spendSlot(store, character, rules, slotLevel);
    };
    if (s.healing) {
      targeting.start({ kind: 'heal', attackerId: token.id, label: s.name, dice: spellDiceAt(s, slotLevel, character?.level ?? 1, 'healing'), bonus: spellAbility(s.index) && d ? d.mods[spellAbility(s.index)!] : 0, rangeFt: s.rangeFt ?? 5, onDone: onCast });
    } else if (s.attack && s.damage) {
      targeting.start({ kind: 'attack', attackerId: token.id, label: s.name, toHit: spellAttack(s.index), damage, rangeFt: s.rangeFt ?? 5, melee: s.attack === 'melee', concentration: conc, onDone: onCast });
    } else if (s.save) {
      targeting.start({
        kind: 'save', attackerId: token.id, label: s.name, ability: s.save, dc: spellDc(s.index), damage, half: halfOnSave(s.description), rangeFt: s.rangeFt ?? 5,
        condition: s.condition, concentration: conc, onDone: onCast,
      });
    } else {
      // Spells without a roll: just mark concentration and the slot.
      if (conc) await run(store.request('combat:concentrate', { tokenId: token.id, spell: conc }));
      await onCast();
      close();
    }
  }

  return (
    <div className="actions" data-testid="actions">
      {/* ---------- what's selected, and what to do with it ---------- */}
      {selected && (
        <div className={`action-bar ${selected.kind === 'spell' ? 'spell' : selected.kind === 'move' ? 'move' : 'range'}`} data-testid="action-bar">
          <div className="action-bar-title">
            <strong>
              {selected.kind === 'move' ? `Movement ${fmt(token.speedFt)}` : weapon ? weapon.name : spell ? spell.name : `Range ${fmt((selected as { feet: number }).feet)}`}
            </strong>
            <span className="hint">
              {weapon && `${weapon.save ?? `${weapon.toHit >= 0 ? '+' : ''}${weapon.toHit} to hit`} · ${weapon.damage} · ${weapon.range}`}
              {spell &&
                [
                  spell.level ? `level ${spell.level}` : 'cantrip',
                  spell.range,
                  spellDiceAt(spell, slotLevel, character?.level ?? 1) || spellDiceAt(spell, slotLevel, character?.level ?? 1, 'healing'),
                  spell.save ? `DC ${spellDc(spell.index)} ${spell.save.toUpperCase()}` : spell.attack ? `+${spellAttack(spell.index)} to hit` : '',
                  spell.concentration ? 'concentration' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              {selected.kind === 'move' && 'Shown on your screen.'}
            </span>
          </div>
          {spell && spell.level > 0 && <SlotPicker levels={slotLevels} value={slotLevel} onChange={setSlot} />}
          {error && <p className="error">{error}</p>}
          <div className="button-row">
            <button className="button" onClick={close}>Close</button>
            {highlight.local && (
              <button className={`button ${sameAsShared ? 'on' : ''}`} onClick={toTable} data-testid="show-table">
                {sameAsShared ? 'Hide from the table' : 'Show the table'}
              </button>
            )}
            {weapon && targeting && (
              <button className="button primary important-red" onClick={() => attackWithWeapon(weapon)} data-testid="use-action">
                {weapon.save ? 'Aim' : 'Attack a target'}
              </button>
            )}
            {spell && (spell.area || targeting) && (
              <button className="button primary important" onClick={() => castSpell(spell)} data-testid="use-action">
                {spell.area ? 'Aim' : spell.healing ? 'Heal someone' : spell.attack || spell.save ? 'Choose a target' : 'Cast'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---------- the cards ---------- */}
      <div className="card-grid">
        <button
          className={`action-card move ${selected?.kind === 'move' ? 'on' : ''}`}
          onClick={() => select({ kind: 'move' }, { tokenId: token.id, kind: 'move', feet: token.speedFt })}
          data-testid="card-move"
        >
          <strong>Movement</strong>
          <span>{fmt(token.speedFt)}</span>
        </button>
        {d?.classNumbers.some((n) => n.label === 'Rage damage') && (
          <button className={`action-card rage ${token.raging ? 'on' : ''}`} onClick={() => run(store.request('combat:rage', { tokenId: token.id, on: !token.raging }))}>
            <strong>{token.raging ? 'Raging' : 'Rage'}</strong>
            <span>{token.raging ? 'tap to end' : `${rageNumber?.value} damage, resist B/P/S`}</span>
          </button>
        )}
      </div>

      {weapons.length > 0 && (
        <>
          <h4 className="section-label">Attacks</h4>
          <div className="card-grid">
            {weapons.map((w, i) => (
              <button
                key={i}
                className={`action-card range ${selected?.kind === 'weapon' && selected.index === i ? 'on' : ''}`}
                onClick={() => select({ kind: 'weapon', index: i }, { tokenId: token.id, kind: 'range', feet: w.normalFt ?? w.reachFt, label: w.name, ...(w.longFt ? { longFeet: w.longFt } : {}) })}
                data-testid={`card-${w.name}`}
              >
                <strong>{w.name}</strong>
                <span>
                  {w.save ? w.save : `${w.toHit >= 0 ? '+' : ''}${w.toHit}`} · {w.damage}
                </span>
                <span className="hint">{w.longFt ? `${fmt(w.normalFt!)}/${fmt(w.longFt)}` : fmt(w.reachFt)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {spells.length > 0 && (
        <>
          <h4 className="section-label">Spells</h4>
          <div className="card-grid">
            {spells.map((s) => (
              <button
                key={s.index}
                className={`action-card spell ${selected?.kind === 'spell' && selected.index === s.index ? 'on' : ''}`}
                onClick={() => select({ kind: 'spell', index: s.index }, s.rangeFt ? { tokenId: token.id, kind: 'spell', feet: s.rangeFt, label: s.name } : null)}
                data-testid={`card-${s.name}`}
              >
                <strong>{s.name}</strong>
                <span>
                  {s.area
                    ? describeArea({ shape: s.area.shape, sizeFt: s.area.size, widthFt: s.area.width }, fmt)
                    : s.rangeFt === 5
                      ? 'touch'
                      : s.rangeFt
                        ? fmt(s.rangeFt)
                        : s.range.toLowerCase()}
                </span>
                <span className="hint">
                  {s.level ? `level ${s.level}` : 'cantrip'}
                  {s.concentration ? ' · conc.' : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {(!character || dmTools) && (
        <>
          <h4 className="section-label">Ranges and areas</h4>
          <div className="card-grid">
            {[5, ...GENERIC_RANGES].map((ft) => (
              <button
                key={ft}
                className={`action-card range ${selected?.kind === 'range' && selected.feet === ft ? 'on' : ''}`}
                onClick={() => select({ kind: 'range', feet: ft }, { tokenId: token.id, kind: 'range', feet: ft })}
              >
                <strong>{ft === 5 ? 'Reach' : 'Range'}</strong>
                <span>{fmt(ft)}</span>
              </button>
            ))}
            {SHAPES.map((sh) => (
              <button
                key={sh.shape}
                className={`action-card spell ${aimState.aim?.label === sh.label ? 'on' : ''}`}
                onClick={() => aimState.start({ label: sh.label, spec: { shape: sh.shape, sizeFt: sh.size }, rangeFt: sh.shape === 'sphere' ? 120 : 0, tokenId: token.id, spellLevel: 0 })}
              >
                <strong>{sh.label}</strong>
                <span>{fmt(sh.size)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {(areas.length > 0 || token.concentration) && (
        <>
          <h4 className="section-label">On the map</h4>
          {token.concentration && (
            <div className="row concentration-row">
              <span className="grow">
                Concentrating on <strong>{token.concentration.spell}</strong>
              </span>
              <button className="button small" onClick={() => run(store.request('combat:concentrate', { tokenId: token.id, spell: null }))}>
                Stop
              </button>
            </div>
          )}
          <div className="card-grid">
            {areas.map((a) => (
              <button
                key={a.id}
                className="action-card spell on"
                onClick={() => run(store.request('area:remove', { areaId: a.id }))}
                aria-label={`Remove ${a.label}`}
              >
                <strong>{a.label}</strong>
                <span>tap to remove</span>
              </button>
            ))}
          </div>
        </>
      )}
      {!selected && error && <p className="error">{error}</p>}
    </div>
  );
}
