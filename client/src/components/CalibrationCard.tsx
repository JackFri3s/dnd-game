import { CARD_MM, type TableSettings } from '../../../shared/protocol.ts';
import { hexCorners, hexToPoint } from '../../../shared/hex.ts';
import { formatLength, useSettings } from '../settings.ts';

/**
 * Shown on the Main Screen while the DM calibrates it: a bank-card outline and a
 * few test hexes drawn at the size the screen currently thinks is real.
 */
export function CalibrationCard({ table }: { table: TableSettings }) {
  const { unit } = useSettings();
  const card = { w: CARD_MM.w * table.pxPerMm, h: CARD_MM.h * table.pxPerMm };
  const hexPx = table.hexMm * table.pxPerMm;
  const testHexes = [
    { q: 0, r: 0 },
    { q: 1, r: 0 },
    { q: 2, r: 0 },
  ];
  const ruler = 100 * table.pxPerMm; // 10 cm

  return (
    <main className="calibration">
      <h1>Calibrate the Main Screen</h1>
      <p>
        Hold a bank card flat against the screen, on the outline. The Dungeon Master makes the outline bigger or smaller
        until it matches the card exactly.
      </p>
      <div className="calib-card" style={{ width: card.w, height: card.h }} data-testid="calib-card">
        <span>Bank card</span>
      </div>
      <div className="calib-row">
        <svg width={hexPx * 3 + 4} height={hexPx * 1.2} aria-label="Test hexes">
          <g transform={`translate(${hexPx / 2 + 2} ${hexPx * 0.6}) scale(${hexPx})`}>
            {testHexes.map((h) => {
              const c = hexCorners(hexToPoint(h));
              return (
                <polygon
                  key={h.q}
                  points={c.map((p) => `${p.x},${p.y}`).join(' ')}
                  className="calib-hex"
                  strokeWidth={2 / hexPx}
                />
              );
            })}
          </g>
        </svg>
        <p className="hint">
          Each hex is {formatLength(table.hexMm, unit)} wide. Put a miniature on one to check it fits.
        </p>
      </div>
      <div className="calib-ruler" style={{ width: ruler }}>
        <span>10 cm (3.94 in)</span>
      </div>
      <p className="hint">Keyboard on this screen? Use + and − to adjust, Enter when done.</p>
    </main>
  );
}
