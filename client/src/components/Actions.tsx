import { useState } from 'react';
import type { Area, RoomState, Token } from '../../../shared/protocol.ts';
import { describeArea, fromCaster, type AreaSpec } from '../../../shared/areas.ts';
import { FEET_PER_HEX, hexDistance, type Hex } from '../../../shared/hex.ts';
import { withSummary, type AreaShape, type Character, type RulesData } from '../../../shared/rules.ts';
import type { GameStore } from '../game.ts';
import { formatDistance, useSettings } from '../settings.ts';
import type { AreaPreview } from './HexBoard.tsx';

/** A spell or effect being aimed on the map. */
export interface Aim {
  label: string;
  spec: AreaSpec;
  rangeFt: number | null;
  tokenId: string;
  spellLevel: number; // 0 = cantrip / no slot
  target: Hex | null;
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
          origin: { q: token.q, r: token.r },
          target: aim.target,
        }
      : null;

  function tapHex(hex: Hex) {
    if (!aim || !token) return;
    const self = fromCaster(aim.spec, aim.rangeFt);
    if (!self && aim.rangeFt !== null && hexDistance(token, hex) * FEET_PER_HEX > aim.rangeFt) {
      setError('That is out of range.');
      return;
    }
    if (self && hexDistance(token, hex) === 0) return;
    setError(null);
    setAim({ ...aim, target: hex });
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

  return { aim, preview, error, tapHex, start, cancel, cast };
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
              : 'Tap another hex to move it.'
            : self
              ? 'Tap a hex to point it.'
              : `Tap a hex within ${aim.rangeFt === null ? 'range' : formatDistance(aim.rangeFt, unit)} to place it.`}
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
}: {
  store: GameStore;
  state: RoomState;
  token: Token;
  character: Character | null;
  rules: RulesData | null;
  aimState: ReturnType<typeof useAim>;
  canRemoveArea: (a: Area) => boolean;
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

  // Weapons: melee reach, or normal/long range.
  const weapons =
    character && rules
      ? character.items
          .map((i) => ({ item: i, w: i.index ? rules.items.find((r) => r.index === i.index)?.weapon : undefined }))
          .filter((x) => x.w)
          .map(({ item, w }) => ({
            name: item.name,
            feet: w!.ranged || (w!.properties.includes('Thrown') && w!.range?.long) ? w!.range?.normal ?? 5 : w!.properties.includes('Reach') ? 10 : 5,
            longFeet: w!.ranged || w!.properties.includes('Thrown') ? w!.range?.long : undefined,
            ranged: !!w!.ranged,
          }))
      : [];
  const spells =
    character && rules
      ? [...character.cantrips, ...character.spells].map((id) => rules.spells.find((s) => s.index === id)).filter((s) => !!s)
      : [];
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
              <button key={i} className={`chip range ${isOn('range', w.feet, w.name) ? 'on' : ''}`} onClick={() => show('range', w.feet, w.name, w.longFeet)}>
                {w.name} <span className="chip-meta">{w.longFeet ? `${fmt(w.feet)}/${fmt(w.longFeet)}` : fmt(w.feet)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {spells.length > 0 && (
        <>
          <div className="label">Spells</div>
          <div className="chip-row">
            {spells.map((s) =>
              s.area ? (
                <button
                  key={s.index}
                  className={`chip spell ${aimState.aim?.label === s.name ? 'on' : ''}`}
                  onClick={() =>
                    aimState.start({ label: s.name, spec: { shape: s.area!.shape, sizeFt: s.area!.size, widthFt: s.area!.width }, rangeFt: s.rangeFt, tokenId: token.id, spellLevel: s.level })
                  }
                >
                  {s.name} <span className="chip-meta">{describeArea({ shape: s.area.shape, sizeFt: s.area.size, widthFt: s.area.width }, fmt)}</span>
                </button>
              ) : (
                <button
                  key={s.index}
                  className={`chip spell ${isOn('spell', s.rangeFt ?? 0, s.name) ? 'on' : ''}`}
                  disabled={!s.rangeFt}
                  onClick={() => show('spell', s.rangeFt ?? 0, s.name)}
                  title={s.range}
                >
                  {s.name} <span className="chip-meta">{s.rangeFt === 5 ? 'touch' : s.rangeFt ? fmt(s.rangeFt) : s.range.toLowerCase()}</span>
                </button>
              ),
            )}
          </div>
        </>
      )}

      {!character && (
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
