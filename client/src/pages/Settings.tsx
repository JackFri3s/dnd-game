import { useSettings, updateSettings, type DistanceUnit, type Theme } from '../settings.ts';

const UNITS: { id: DistanceUnit; label: string; hint: string }[] = [
  { id: 'hex', label: 'Hexes', hint: '1 hex = 5 ft' },
  { id: 'ft', label: 'Feet', hint: 'As in the rule books' },
  { id: 'm', label: 'Metres', hint: '1 hex = 1.5 m' },
];
const THEMES: { id: Theme; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Settings for this device. */
export function SettingsPage() {
  const settings = useSettings();
  return (
    <main className="page">
      <header className="page-header">
        <a href="/" className="back">← Back</a>
        <h1>Settings</h1>
      </header>
      <section className="card">
        <h2>Distances</h2>
        <p className="hint">How movement and ranges are shown on this device.</p>
        <div className="segmented" role="radiogroup" aria-label="Distances">
          {UNITS.map((u) => (
            <button
              key={u.id}
              role="radio"
              aria-checked={settings.unit === u.id}
              className={settings.unit === u.id ? 'on' : ''}
              onClick={() => updateSettings({ unit: u.id })}
            >
              {u.label}
              <small>{u.hint}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Appearance</h2>
        <div className="segmented" role="radiogroup" aria-label="Appearance">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={settings.theme === t.id}
              className={settings.theme === t.id ? 'on' : ''}
              onClick={() => updateSettings({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>
      <p className="hint">Settings are saved on this device only.</p>
    </main>
  );
}
