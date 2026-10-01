import { useSyncExternalStore } from 'react';
import { prefs } from './prefs';

export type Theme = 'light' | 'dark' | 'system';
const listeners = new Set<() => void>();
let theme: Theme = prefs.get<Theme>('theme', 'system');
const media = window.matchMedia('(prefers-color-scheme: dark)');

function apply() {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0d0d10' : '#f6f6f7');
}
apply();
media.addEventListener('change', () => { apply(); listeners.forEach(l => l()); });

export function setTheme(t: Theme) {
  theme = t;
  prefs.set('theme', t);
  apply();
  listeners.forEach(l => l());
}

export function useTheme() {
  // the snapshot includes the OS setting so "system" re-renders when it flips
  const snap = useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => `${theme}:${media.matches}`);
  const t = snap.split(':')[0] as Theme;
  const resolved: 'light' | 'dark' = t === 'system' ? (media.matches ? 'dark' : 'light') : t;
  return { theme: t, resolved, setTheme };
}
