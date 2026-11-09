import type { Highlight, Token } from '../../../shared/protocol.ts';
import { formatDistance, useSettings } from '../settings.ts';

/** Ranges offered as quick buttons, in feet (5 ft = 1 hex). */
const RANGES = [5, 30, 60, 120];

/** Buttons to show a token's movement or a range around it on every screen. */
export function RangeChips({
  token,
  highlight,
  onShow,
}: {
  token: Token;
  highlight: Highlight | null;
  onShow: (h: Omit<Highlight, 'tokenId'> | null) => void;
}) {
  const { unit } = useSettings();
  const active = highlight?.tokenId === token.id ? highlight : null;
  return (
    <div className="chip-row">
      <button
        className={`chip ${active?.kind === 'move' ? 'on' : ''}`}
        onClick={() => onShow(active?.kind === 'move' ? null : { kind: 'move', feet: token.speedFt })}
      >
        Movement {formatDistance(token.speedFt, unit)}
      </button>
      {RANGES.map((ft) => {
        const on = active?.kind === 'range' && active.feet === ft;
        return (
          <button key={ft} className={`chip ${on ? 'on' : ''}`} onClick={() => onShow(on ? null : { kind: 'range', feet: ft })}>
            {ft === 5 ? 'Reach' : 'Range'} {formatDistance(ft, unit)}
          </button>
        );
      })}
      {highlight && (
        <button className="chip" onClick={() => onShow(null)}>
          Hide
        </button>
      )}
    </div>
  );
}
