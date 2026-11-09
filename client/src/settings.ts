import { useEffect, useState, useSyncExternalStore } from 'react';
import { read, write } from './socket.ts';

// Settings for this device (chosen from the home menu: Settings).

export type DistanceUnit = 'ft' | 'm';
export type Theme = 'auto' | 'light' | 'dark';
export type Style = 'minimal' | 'parchment';
/** Where the controls sit during play, around the map. */
export type PanelSide = 'auto' | 'bottom' | 'right' | 'top' | 'left';

export interface Settings {
  unit: DistanceUnit;
  theme: Theme;
  style: Style;
  panel: PanelSide;
}

const DEFAULTS: Settings = { unit: 'ft', theme: 'auto', style: 'minimal', panel: 'auto' };
const listeners = new Set<() => void>();

let current: Settings = (() => {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(read('dnd.settings') ?? '{}') };
    if (saved.unit !== 'ft' && saved.unit !== 'm') saved.unit = 'ft'; // "hexes" is gone with the grid
    return saved;
  } catch {
    return DEFAULTS;
  }
})();

export function getSettings() {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  write('dnd.settings', JSON.stringify(current));
  applyTheme();
  listeners.forEach((fn) => fn());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

export function applyTheme() {
  const root = document.documentElement;
  if (current.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', current.theme);
  if (current.style === 'parchment') root.setAttribute('data-style', 'parchment');
  else root.removeAttribute('data-style');
}

/** A rules distance (in feet, as 5e uses) shown in the chosen unit; 5 ft = 1.5 m as in the metric rules. */
export function formatDistance(feet: number, unit: DistanceUnit): string {
  if (unit === 'm') return `${+((feet / 5) * 1.5).toFixed(1)} m`;
  return `${feet} ft`;
}

/** A physical size on the table (e.g. how long 5 ft is), metric or imperial to match the unit. */
export function formatLength(mm: number, unit: DistanceUnit): string {
  return unit === 'm' ? `${+mm.toFixed(1)} mm` : `${+(mm / 25.4).toFixed(2)} in`;
}

/** The panel side to use now: "auto" means at the side when the screen is wide, at the bottom when tall. */
export function usePanelSide(): Exclude<PanelSide, 'auto'> {
  const { panel } = useSettings();
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth > window.innerHeight && window.innerWidth >= 700);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth > window.innerHeight && window.innerWidth >= 700);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return panel === 'auto' ? (wide ? 'right' : 'bottom') : panel;
}

const NEXT_SIDE: Record<Exclude<PanelSide, 'auto'>, Exclude<PanelSide, 'auto'>> = { bottom: 'right', right: 'top', top: 'left', left: 'bottom' };

/** A small button that moves the controls to the next side of the map. */
export function nextPanelSide(current: Exclude<PanelSide, 'auto'>) {
  updateSettings({ panel: NEXT_SIDE[current] });
}
