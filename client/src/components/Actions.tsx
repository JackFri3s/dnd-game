import { useState } from 'react';
import type { Area, RoomState, Token } from '../../../shared/protocol.ts';
import { describeArea, dist, fromCaster, inRange, type AreaSpec, type Point } from '../../../shared/geometry.ts';
import { derive, withSummary, type Ability, type AreaShape, type Character, type RulesData } from '../../../shared/rules.ts';
import { areaGeometry, touchesArea } from '../../../shared/geometry.ts';
import { parseDamageText, type useTargeting } from './Combat.tsx';
import type { GameStore } from '../game.ts';
import { formatDistance, useSettings } from '../settings.ts';
import type { AreaPreview } from './MapBoard.tsx';

/** A spell or effect being aimed on the map. */
export interface Aim {
  label: string;
  spec: AreaSpec;
  rangeFt: number | null;
  tokenId: string;
  spellLevel: number; // 0 = cantrip / no slot
  target: Point | null;
  /** Spells that ask for a saving throw: everyone in the area rolls when it's cast. */
  save?: { ability: Ability; dc: number; damage: string; half: boolean };
}

/** Everything a page needs to aim and cast an area. */
export function useAim(store: GameStore, state: RoomState) {
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
    // The point of origin must be within range (0 ft = touching the caster's space).
    if (!self && aim.rangeFt !== null && !inRange(token, at, aim.rangeFt) && dist(token, at) > 0.5) {
      setError('That is out of range.');
      return;
    }
    if (self && dist(token, at) < 0.2) return;
    setError(null);
    setAim({ ...aim, target: at });
  }

  function start(next: Omit<Aim, 'target'>) {
    setError(null);
    setAim({ ...next, target: null });
    // Show the spell's range around the caster on every screen while aiming.
    if (next.rangeFt && !fromCaster(next.spec, next.rangeFt)) {
      store.request('highlight:set', { highlight: { tokenId: next.tokenId, kind: 'spell', feet: next.rangeFt, label: next.label } }).catch(() => {});
    }
  }

  function cancel() {
    setAim(null);
    setError(null);
    if (state.highlight?.kind === 'spell') store.request('highlight:set', { highlight: null }).catch(() => {});
  }

  async function cast(character: Character | null, rules: RulesData | null) {
    if (!preview || !aim) return;
    try {
      await store.request('area:add', { area: preview });
      // Everyone (partly) inside the area makes the saving throw; damage is applied.
      if (aim.save) {
        const g = areaGeometry(aim.spec, preview.origin, preview.target, aim.rangeFt);
        const caster = state.tokens.find((t) => t.id === aim.tokenId);
        const targetIds = state.tokens.filter((t) => touchesArea(g, t) && (t.id !== aim.tokenId || !fromCaster(aim.spec, aim.rangeFt))).map((t) => t.id);
        if (targetIds.length) {
          const d = parseDamageText(aim.save.damage);
          await store.request('combat:save', {
            attackerId: caster?.id ?? null,
            targetIds,
            label: aim.label,
            ability: aim.save.ability,
            dc: aim.save.dc,
            damage: d.dice,
            damageBonus: d.bonus,
            damageType: d.type,
            half: aim.save.half,
          });
        }
      }
      // Use the lowest free spell slot of the spell's level or higher.
      if (character && rules && aim.spellLevel > 0) {
        const slots = rules.classes.find((c) => c.index === character.classIndex)?.levels.find((l) => l.level === character.level)?.slots ?? [];
        const lvl = slots.findIndex((n, i) => i >= aim.spellLevel - 1 && n > character.spellSlotsUsed[i]);
        if (lvl >= 0) {
          const used = [...character.spellSlotsUsed];
          used[lvl] += 1;
          await store.request('character:save', { character: withSummary({ ...character, spellSlotsUsed: used }, rules) });
        }
      }
      cancel();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { aim, preview, error, tapMap, start, cancel, cast };
}

/** The bar shown while aiming: what is being cast, and Cast / Cancel. */
export function AimBar({
  aimState,
  character,
  rules,
}: {
  aimState: ReturnType<typeof useAim>;
  character: Character | null;
  rules: RulesData | null;
}) {
  const { unit } = useSettings();
  const { aim, preview, error } = aimState;
  if (!aim) return null;
  const self = fromCaster(aim.spec, aim.rangeFt);
  const slots = character && rules ? rules.classes.find((c) => c.index === character.classIndex)?.levels.find((l) => l.level === character.level)?.slots : undefined;
  const freeSlot = slots?.findIndex((n, i) => i >= aim.spellLevel - 1 && n > (character?.spellSlotsUsed[i] ?? 0)) ?? -1;
  return (
    <div className="aim-bar" data-testid="aim-bar">
      <div className="grow">
        <strong>{aim.label}</strong> <span className="hint">{describeArea(aim.spec, (ft) => formatDistance(ft, unit))}</span>
        <div className="hint">
          {preview
            ? aim.spellLevel > 0
              ? freeSlot >= 0
                ? `Uses a level ${freeSlot + 1} spell slot.`
                : 'No spell slots left (cast anyway?).'
              : 'Tap somewhere else to move it.'
            : self
              ? 'Tap the map to point it.'
              : `Tap a spot within ${aim.rangeFt === null ? 'range' : formatDistance(aim.rangeFt, unit)} to place it.`}
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      <button className="button small" onClick={aimState.cancel}>Cancel</button>
      <button className="button small primary important" disabled={!preview} onClick={() => aimState.cast(character, rules)} data-testid="cast">
        Cast
      </button>
    </div>
  );
}

const GENERIC_RANGES = [30, 60, 120];
const SHAPES: { shape: AreaShape; label: string; size: number }[] = [
  { shape: 'sphere', label: 'Circle', size: 20 },
  { shape: 'cone', label: 'Cone', size: 15 },
  { shape: 'line', label: 'Line', size: 60 },
  { shape: 'cube', label: 'Square', size: 15 },
];

/**
 * What a token can do, as buttons: show its movement, the range of each weapon
 * and spell, and aim spell areas. For a token without a character (e.g. a
 * monster) there are general ranges and shapes instead.
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
  /** Attacks and single-target spells: choose a target to resolve them. */
  targeting?: ReturnType<typeof useTargeting>;
}) {
  const { unit } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const h = state.highlight?.tokenId === token.id ? state.highlight : null;
  const fmt = (ft: number) => formatDistance(ft, unit);
  const show = (kind: 'move' | 'range' | 'spell', feet: number, label?: string, longFeet?: number) => {
    const on = h?.kind === kind && h.feet === feet && h.label === label;
    store
      .request('highlight:set', { highlight: on ? null : { tokenId: token.id, kind, feet, ...(label ? { label } : {}), ...(longFeet ? { longFeet } : {}) } })
      .then(() => setError(null), (e: Error) => setError(e.message));
  };
  const isOn = (kind: string, feet: number, label?: string) => h?.kind === kind && h.feet === feet && h.label === label;

  // Attacks and spells, worked out from the character.
  const d = character && rules ? derive(character, rules) : null;
  const weapons = d ? d.attacks : [];
  const spells =
    character && rules
      ? [...new Set([...character.cantrips, ...character.spells, ...(d?.bonusSpells ?? []).map((b) => b.index)])]
          .map((id) => rules.spells.find((s) => s.index === id))
          .filter((s): s is NonNullable<typeof s> => !!s)
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

  function pickWeapon(w: (typeof weapons)[number]) {
    const feet = w.normalFt ?? w.reachFt;
    if (!targeting) return show('range', feet, w.name, w.longFt);
    if (w.saveAbility && w.dc) {
      // Breath Weapon: aim the cone/line like a spell.
      return aimState.start({
        label: w.name, spec: { shape: 'cone', sizeFt: 15 }, rangeFt: 0, tokenId: token.id, spellLevel: 0,
        save: { ability: w.saveAbility, dc: w.dc, damage: w.damage, half: true },
      });
    }
    targeting.start({ kind: 'attack', attackerId: token.id, label: w.name, toHit: w.toHit, damage: w.damage, rangeFt: feet, longFt: w.longFt });
  }

  function pickSpell(s: (typeof spells)[number]) {
    if (s.area) {
      return aimState.start({
        label: s.name,
        spec: { shape: s.area.shape, sizeFt: s.area.size, widthFt: s.area.width },
        rangeFt: s.rangeFt,
        tokenId: token.id,
        spellLevel: s.level,
        ...(s.save ? { save: { ability: s.save, dc: spellDc(s.index), damage: s.damage ?? '', half: halfOnSave(s.description) } } : {}),
      });
    }
    if (targeting && s.attack && s.damage) {
      return targeting.start({ kind: 'attack', attackerId: token.id, label: s.name, toHit: spellAttack(s.index), damage: s.damage, rangeFt: s.rangeFt ?? 5 });
    }
    if (targeting && s.save) {
      return targeting.start({ kind: 'save', attackerId: token.id, label: s.name, ability: s.save, dc: spellDc(s.index), damage: s.damage ?? '', half: halfOnSave(s.description), rangeFt: s.rangeFt ?? 5 });
    }
    show('spell', s.rangeFt ?? 0, s.name);
  }

  const areas = state.areas.filter((a) => canRemoveArea(a));

  return (
    <div className="actions" data-testid="actions">
      <div className="chip-row">
        <button className={`chip move ${isOn('move', token.speedFt) ? 'on' : ''}`} onClick={() => show('move', token.speedFt)}>
          Movement {fmt(token.speedFt)}
        </button>
        {h && (
          <button className="chip" onClick={() => store.request('highlight:set', { highlight: null })}>
            Hide
          </button>
        )}
      </div>

      {weapons.length > 0 && (
        <>
          <div className="label">Attacks</div>
          <div className="chip-row">
            {weapons.map((w, i) => (
              <button
                key={i}
                className={`chip range ${targeting?.pending?.label === w.name || isOn('range', w.normalFt ?? w.reachFt, w.name) ? 'on' : ''}`}
                onClick={() => pickWeapon(w)}
              >
                {w.name}{' '}
                <span className="chip-meta">
                  {w.save ? w.save : `${w.toHit >= 0 ? '+' : ''}${w.toHit}`} · {w.longFt ? `${fmt(w.normalFt!)}/${fmt(w.longFt)}` : fmt(w.reachFt)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {spells.length > 0 && (
        <>
          <div className="label">Spells</div>
          <div className="chip-row">
            {spells.map((s) => (
              <button
                key={s.index}
                className={`chip spell ${aimState.aim?.label === s.name || targeting?.pending?.label === s.name || isOn('spell', s.rangeFt ?? 0, s.name) ? 'on' : ''}`}
                disabled={!s.area && !s.rangeFt}
                onClick={() => pickSpell(s)}
                title={s.range}
              >
                {s.name}{' '}
                <span className="chip-meta">
                  {s.area
                    ? describeArea({ shape: s.area.shape, sizeFt: s.area.size, widthFt: s.area.width }, fmt)
                    : s.rangeFt === 5
                      ? 'touch'
                      : s.rangeFt
                        ? fmt(s.rangeFt)
                        : s.range.toLowerCase()}
                  {s.save ? ` · DC ${spellDc(s.index)}` : s.attack ? ` · +${spellAttack(s.index)}` : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {(!character || dmTools) && (
        <>
          <div className="label">Ranges</div>
          <div className="chip-row">
            <button className={`chip range ${isOn('range', 5) ? 'on' : ''}`} onClick={() => show('range', 5)}>
              Reach {fmt(5)}
            </button>
            {GENERIC_RANGES.map((ft) => (
              <button key={ft} className={`chip range ${isOn('range', ft) ? 'on' : ''}`} onClick={() => show('range', ft)}>
                Range {fmt(ft)}
              </button>
            ))}
          </div>
          <div className="label">Areas</div>
          <div className="chip-row">
            {SHAPES.map((sh) => (
              <button
                key={sh.shape}
                className={`chip spell ${aimState.aim?.label === sh.label ? 'on' : ''}`}
                onClick={() => aimState.start({ label: sh.label, spec: { shape: sh.shape, sizeFt: sh.size }, rangeFt: sh.shape === 'sphere' ? 120 : 0, tokenId: token.id, spellLevel: 0 })}
              >
                {sh.label} <span className="chip-meta">{fmt(sh.size)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {areas.length > 0 && (
        <>
          <div className="label">On the map</div>
          <div className="chip-row">
            {areas.map((a) => (
              <button
                key={a.id}
                className="chip spell on"
                onClick={() => store.request('area:remove', { areaId: a.id }).then(() => setError(null), (e: Error) => setError(e.message))}
                aria-label={`Remove ${a.label}`}
              >
                {a.label} ✕
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
