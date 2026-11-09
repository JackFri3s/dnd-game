import { useEffect, useState } from 'react';
import { SEATS, type RoomState } from '../../../shared/protocol.ts';
import { SIDE_ROTATION } from '../seats.ts';

const SHOW_MS = 9000;

/**
 * On the Main Screen: recent dice rolls, shown at the edge where the roller sits
 * and turned to face them (the DM's rolls appear at the bottom).
 */
export function RollToasts({ state }: { state: RoomState }) {
  const [now, setNow] = useState(Date.now());
  const [since] = useState(() => Date.now() - 2000); // don't replay old rolls after a reload
  const fresh = state.rolls.filter((r) => r.at > since && now - r.at < SHOW_MS);

  useEffect(() => {
    if (!fresh.length) return;
    const t = setTimeout(() => setNow(Date.now()), 500);
    return () => clearTimeout(t);
  });
  useEffect(() => setNow(Date.now()), [state.rolls]);

  if (!fresh.length) return null;
  // Group by side of the table so several rolls stack neatly.
  const bySide = new Map<string, typeof fresh>();
  for (const r of fresh) {
    const seat = state.members.find((m) => m.id === r.byId)?.seat;
    const side = SEATS.find((s) => s.id === seat)?.side ?? 'bottom';
    bySide.set(side, [...(bySide.get(side) ?? []), r]);
  }

  return (
    <div className="roll-layer">
      {[...bySide].map(([side, rolls]) => (
        <div key={side} className={`roll-stack roll-${side}`}>
          <div className="roll-stack-inner" style={{ transform: `rotate(${SIDE_ROTATION[side as keyof typeof SIDE_ROTATION]}deg)` }}>
            {rolls.slice(0, 2).map((r) => (
              <div key={r.id} className="roll-card" data-testid="table-roll">
                <div className="hint">{r.label}</div>
                {r.groups.length > 1 ? (
                  <div className="roll-sets">
                    {r.groups.map((g, i) => (
                      <span key={i}>
                        <strong>{g.total}</strong>
                        <small>{g.rolls.join(' ')}</small>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="roll-total">
                    <strong>{r.total}</strong>
                    <small>
                      {r.groups[0].rolls.join(' + ')}
                      {r.modifier ? ` ${r.modifier > 0 ? '+' : '−'} ${Math.abs(r.modifier)}` : ''}
                      {r.groups[0].sides === 20 && r.groups[0].rolls[0] === 20 ? ' · natural 20!' : ''}
                      {r.groups[0].sides === 20 && r.groups[0].rolls[0] === 1 ? ' · natural 1' : ''}
                    </small>
                  </div>
                )}
                <div className="hint">{r.byName}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
