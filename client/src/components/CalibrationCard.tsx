import { CARD_MM, type TableSettings } from '../../../shared/protocol.ts';
import { formatLength, useSettings } from '../settings.ts';

/**
 * Shown on the Main Screen while the DM calibrates it: a bank-card outline and a
 * few test spaces drawn at the size the screen currently thinks is real.
 */
export function CalibrationCard({ table }: { table: TableSettings }) {
  const { unit } = useSettings();
  const card = { w: CARD_MM.w * table.pxPerMm, h: CARD_MM.h * table.pxPerMm };
  const unitPx = table.hexMm * table.pxPerMm; // one 5-foot space
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
        <svg width={unitPx * 3.4} height={unitPx * 1.2} aria-label="Test spaces">
          {[0, 1, 2].map((i) => (
            <circle key={i} className="calib-hex" cx={unitPx * (0.6 + i * 1.1)} cy={unitPx * 0.6} r={unitPx / 2 - 1} strokeWidth={2} />
          ))}
        </svg>
        <p className="hint">
          Each circle is one 5-foot space: {formatLength(table.hexMm, unit)} across. Put a miniature on one to check it fits.
        </p>
      </div>
      <div className="calib-ruler" style={{ width: ruler }}>
        <span>10 cm (3.94 in)</span>
      </div>
      <p className="hint">Keyboard on this screen? Use + and − to adjust, Enter when done.</p>
    </main>
  );
}
