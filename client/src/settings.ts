import { useSyncExternalStore } from 'react';
import { FEET_PER_HEX } from '../../shared/hex.ts';
import { read, write } from './socket.ts';

// Settings for this device (chosen from the home menu: Settings).

export type DistanceUnit = 'hex' | 'ft' | 'm';
export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  unit: DistanceUnit;
  theme: Theme;
}

const DEFAULTS: Settings = { unit: 'hex', theme: 'auto' };
const listeners = new Set<() => void>();

let current: Settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(read('dnd.settings') ?? '{}') };
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
}

/** A rules distance (in feet, as 5e uses) shown in the chosen unit. 5 ft = 1 hex = 1.5 m. */
export function formatDistance(feet: number, unit: DistanceUnit): string {
  const hexes = feet / FEET_PER_HEX;
  if (unit === 'hex') return `${hexes} ${hexes === 1 ? 'hex' : 'hexes'}`;
  if (unit === 'm') return `${+(hexes * 1.5).toFixed(1)} m`;
  return `${feet} ft`;
}

/** A physical size on the table (e.g. hex width), metric or imperial to match the unit. */
export function formatLength(mm: number, unit: DistanceUnit): string {
  return unit === 'm' ? `${+mm.toFixed(1)} mm` : `${+(mm / 25.4).toFixed(2)} in`;
}
