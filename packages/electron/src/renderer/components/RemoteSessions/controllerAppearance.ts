/**
 * Controller appearance — theme + window transparency.
 *
 * The controller can be dressed to look like different things (a terminal, a
 * code editor, a light notes pad) so it doesn't obviously read as "an app", and
 * its window can be made semi-transparent. Both are persisted in app-settings and
 * applied ONLY to the popover window (never the normal app window).
 */
import { useCallback, useEffect, useState } from 'react';

export type ControllerTheme = 'midnight' | 'terminal' | 'editor' | 'paper';

export interface ControllerAppearance {
  theme: ControllerTheme;
  /** Window opacity as a percent, 60–100. */
  opacity: number;
}

export const THEMES: Array<{ id: ControllerTheme; label: string }> = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor' },
  { id: 'paper', label: 'Paper' },
];

export const OPACITY_STEPS = [100, 92, 85, 75] as const;

export const DEFAULT_APPEARANCE: ControllerAppearance = { theme: 'midnight', opacity: 100 };

/**
 * Theme palettes applied as inline `--nim-*` vars. They MUST be set inline with
 * `!important` because index.tsx seeds the popover skin the same way — a plain
 * stylesheet rule would lose to it. Midnight mirrors that default skin.
 */
const THEME_PALETTES: Record<ControllerTheme, Record<string, string>> = {
  midnight: {
    '--nim-bg': '#0a0d13',
    '--nim-bg-secondary': '#0f141d',
    '--nim-bg-tertiary': '#0c1017',
    '--nim-bg-hover': '#161c27',
    '--nim-bg-selected': '#1a2233',
    '--nim-text': '#d7e0ec',
    '--nim-text-muted': '#66748a',
    '--nim-border': '#1b2330',
    '--nim-primary': '#2f81f7',
    '--nim-success': '#3fb950',
    '--nim-warning': '#d29922',
    '--nim-error': '#f85149',
  },
  terminal: {
    '--nim-bg': '#000000',
    '--nim-bg-secondary': '#071807',
    '--nim-bg-tertiary': '#041004',
    '--nim-bg-hover': '#0e2c14',
    '--nim-bg-selected': '#0e2c14',
    '--nim-text': '#35ff6a',
    '--nim-text-muted': '#1f9f3f',
    '--nim-border': '#0f3f1f',
    '--nim-primary': '#9dff4d',
    '--nim-success': '#35ff6a',
    '--nim-warning': '#ffcc33',
    '--nim-error': '#ff5f56',
  },
  editor: {
    '--nim-bg': '#1e1e1e',
    '--nim-bg-secondary': '#252526',
    '--nim-bg-tertiary': '#1b1b1b',
    '--nim-bg-hover': '#2a2d2e',
    '--nim-bg-selected': '#094771',
    '--nim-text': '#d4d4d4',
    '--nim-text-muted': '#858585',
    '--nim-border': '#333333',
    '--nim-primary': '#569cd6',
    '--nim-success': '#4ec9b0',
    '--nim-warning': '#cca700',
    '--nim-error': '#f48771',
  },
  paper: {
    '--nim-bg': '#faf8f3',
    '--nim-bg-secondary': '#f0ece2',
    '--nim-bg-tertiary': '#f5f2ea',
    '--nim-bg-hover': '#efe7d6',
    '--nim-bg-selected': '#e6dcc8',
    '--nim-text': '#2b2b2b',
    '--nim-text-muted': '#8a8378',
    '--nim-border': '#e2dbcd',
    '--nim-primary': '#b5651d',
    '--nim-success': '#3a7d44',
    '--nim-warning': '#b5651d',
    '--nim-error': '#b00020',
  },
};

/** Apply a theme's palette inline (with !important) to the popover root. */
export function applyControllerTheme(theme: ControllerTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-controller-theme', theme);
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.midnight;
  for (const [k, v] of Object.entries(palette)) root.style.setProperty(k, v, 'important');
}

const KEY = 'controllerAppearance';

function isPopover(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-controller-popover');
}

async function load(): Promise<ControllerAppearance> {
  try {
    const stored = (await window.electronAPI?.invoke?.('app-settings:get', KEY)) as
      | Partial<ControllerAppearance>
      | undefined;
    return { ...DEFAULT_APPEARANCE, ...(stored ?? {}) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

async function save(a: ControllerAppearance): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('app-settings:set', KEY, a);
  } catch {
    /* non-fatal */
  }
}

/** React hook: persisted appearance + setters that apply theme (popover only) and window opacity. */
export function useControllerAppearance(): {
  appearance: ControllerAppearance;
  setTheme: (theme: ControllerTheme) => void;
  setOpacity: (opacity: number) => void;
} {
  const [appearance, setAppearance] = useState<ControllerAppearance>(DEFAULT_APPEARANCE);

  useEffect(() => {
    let live = true;
    void load().then((a) => {
      if (live) setAppearance(a);
    });
    return () => {
      live = false;
    };
  }, []);

  // Apply: theme drives CSS variables on the popover root; opacity drives the
  // window (main process). Both are no-ops outside the popover so the normal app
  // window is never re-skinned.
  useEffect(() => {
    if (!isPopover()) return;
    applyControllerTheme(appearance.theme);
    void window.electronAPI?.invoke?.('controller-popover:set-opacity', appearance.opacity / 100);
  }, [appearance.theme, appearance.opacity]);

  const setTheme = useCallback((theme: ControllerTheme) => {
    setAppearance((prev) => {
      const next = { ...prev, theme };
      void save(next);
      return next;
    });
  }, []);

  const setOpacity = useCallback((opacity: number) => {
    setAppearance((prev) => {
      const next = { ...prev, opacity };
      void save(next);
      return next;
    });
  }, []);

  return { appearance, setTheme, setOpacity };
}
