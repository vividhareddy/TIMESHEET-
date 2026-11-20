import { useCallback, useSyncExternalStore } from 'react';

/**
 * Light / dark theme, shared with the LMS: both portals run on the same address and store the choice under the same
 * key, so switching in one switches the other (other open tabs and the LMS's assistant frame follow via "storage"
 * events). index.html applies the saved theme before the first paint; colours switch through CSS variables
 * (src/index.css).
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'shimentox-theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let current: Theme = read();

function apply(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0e141b' : '#1e293b');
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  apply(current);
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_KEY || event.key === null) apply(read());
  });
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  apply(theme);
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
  const toggle = useCallback(() => setTheme(current === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}
