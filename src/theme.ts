export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'enphase-local-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The theme the user picked on this device, or null to follow the system. */
export function loadTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* private mode — the choice just won't persist */ }
}

export function systemTheme(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Follow the system theme until the user picks one; report changes. */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches ? 'dark' : 'light');
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

/**
 * Set data-theme on <html>. The stylesheet applies the dark palette when
 * data-theme is "dark", or when it is absent and the system prefers dark.
 */
export function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
