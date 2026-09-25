export type Theme = 'system' | 'light' | 'dark';

export const THEMES: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const STORAGE_KEY = 'enphase-local-theme';

/** The theme chosen on this device; "system" when nothing has been chosen. */
export function loadTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* private mode — the choice just won't persist */ }
}

/**
 * Set data-theme on <html>. The stylesheet applies the dark palette when
 * data-theme is "dark", or when it is absent and the system prefers dark.
 */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
