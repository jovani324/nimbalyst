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
    document.documentElement.setAttribute('data-controller-theme', appearance.theme);
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
