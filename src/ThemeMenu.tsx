import React, { useEffect, useId, useRef, useState } from 'react';
import { THEMES, type Theme } from './theme.js';

/**
 * Appearance control: one icon button (sun / moon / sun-moon for the current
 * choice) that opens a Light / Dark / System menu. Same pattern as the
 * ThemeModeToggle in the manja project, built here with plain elements and
 * inline SVG so the page stays a single offline file.
 *
 * Icon paths are lucide's "sun", "moon" and "sun-moon" (ISC licence).
 */

const ICON_PATHS: Record<Theme, React.ReactNode> = {
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  dark: (
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />
  ),
  system: (
    <>
      <path d="M12 2v2" />
      <path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715" />
      <path d="M16 12a4 4 0 0 0-4-4M19 5l-1.256 1.256M20 12h2" />
    </>
  ),
};

function ThemeIcon({ theme, size }: { theme: Theme; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[theme]}
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

interface Props {
  theme: Theme;
  onChange: (theme: Theme) => void;
}

export default function ThemeMenu({ theme, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  // Close on a click outside or Escape; give focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus the current choice when the menu opens.
  useEffect(() => {
    if (!open) return;
    const index = THEMES.findIndex((option) => option.value === theme);
    itemRefs.current[Math.max(0, index)]?.focus();
  }, [open, theme]);

  const choose = (value: Theme) => {
    onChange(value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const index = itemRefs.current.findIndex((element) => element === document.activeElement);
    const count = THEMES.length;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (index + 1) % count;
    if (event.key === 'ArrowUp') next = (index - 1 + count) % count;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = count - 1;
    if (next !== null) {
      event.preventDefault();
      itemRefs.current[next]?.focus();
    }
  };

  const current = THEMES.find((option) => option.value === theme) ?? THEMES[0];

  return (
    <div className="theme-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="theme-menu-button"
        aria-label={`Appearance: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <ThemeIcon theme={theme} size={18} />
      </button>
      {open && (
        <div className="theme-menu-list" id={menuId} role="menu" aria-label="Appearance" onKeyDown={onMenuKeyDown}>
          {THEMES.map((option, index) => {
            const selected = option.value === theme;
            return (
              <button
                key={option.value}
                ref={(element) => { itemRefs.current[index] = element; }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`theme-menu-item${selected ? ' selected' : ''}`}
                onClick={() => choose(option.value)}
              >
                <ThemeIcon theme={option.value} size={16} />
                <span className="theme-menu-label">{option.label}</span>
                {selected && <CheckIcon />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
