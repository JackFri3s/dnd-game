import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PX_PER_MM, type Requests, type TableSettings } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';

const HEX_SIZES = [
  { mm: 25.4, label: '1 inch (25.4 mm): standard miniatures' },
  { mm: 28, label: '28 mm' },
  { mm: 31.75, label: '1¼ inch (31.75 mm): roomier' },
  { mm: 38.1, label: '1½ inch (38.1 mm): large hexes' },
];

/** DM controls for calibrating the Main Screen, so hexes have a real-world size. */
export function CalibrationControls({ store, table }: { store: GameStore; table: TableSettings }) {
  const [error, setError] = useState<string | null>(null);
  // The slider updates locally right away, and sends to the Main Screen a few times a second.
  const [local, setLocal] = useState(table.pxPerMm);
  const sendTimer = useRef<number | undefined>(undefined);
  useEffect(() => setLocal(table.pxPerMm), [table.pxPerMm]);

  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const send = (args: Requests['table:calibrate']['args']) => run(store.request('table:calibrate', args));

  function setPx(v: number) {
    setLocal(v);
    clearTimeout(sendTimer.current);
    sendTimer.current = window.setTimeout(() => send({ pxPerMm: v }), 120);
  }

  if (!table.calibrating) {
    return (
      <div className="calib-controls">
        <p className="hint">
          {table.calibrated
            ? `Calibrated. Hexes are ${table.hexMm.toFixed(1)} mm wide on the Main Screen.`
            : 'Not calibrated yet. Calibrate so hexes match your miniatures.'}
        </p>
        <button className="secondary" onClick={() => send({ calibrating: true })} data-testid="calibrate">
          📏 Calibrate the Main Screen
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="calib-controls active" data-testid="calib-controls">
      <p>
        <strong>The Main Screen now shows a bank-card outline.</strong> Hold a real bank card on it and adjust until they
        match exactly.
      </p>
      <div className="calib-adjust">
        <button className="small-button" onClick={() => setPx(local * 0.98)} aria-label="Much smaller">−−</button>
        <button className="small-button" onClick={() => setPx(local * 0.998)} aria-label="Smaller">−</button>
        <input
          type="range"
          min={1.5}
          max={8}
          step={0.005}
          value={local}
          onChange={(e) => setPx(Number(e.target.value))}
          aria-label="Card size"
        />
        <button className="small-button" onClick={() => setPx(local * 1.002)} aria-label="Bigger">+</button>
        <button className="small-button" onClick={() => setPx(local * 1.02)} aria-label="Much bigger">++</button>
      </div>
      <label>
        Hex size on the table
        <select value={table.hexMm} onChange={(e) => send({ hexMm: Number(e.target.value) })}>
          {HEX_SIZES.map((h) => (
            <option key={h.mm} value={h.mm}>
              {h.label}
            </option>
          ))}
          {!HEX_SIZES.some((h) => h.mm === table.hexMm) && <option value={table.hexMm}>{table.hexMm} mm</option>}
        </select>
      </label>
      <div className="row-buttons">
        <button className="primary narrow" onClick={() => send({ done: true })} data-testid="calib-done">
          Done
        </button>
        <button className="link-button" onClick={() => setPx(DEFAULT_PX_PER_MM)}>Reset</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
