/**
 * Controller appearance — theme + window transparency.
 *
 * The controller can be dressed to look like different things (a terminal, a
 * code editor, a light notes pad) so it doesn't obviously read as "an app", and
 * its window can be made semi-transparent. Both are persisted in app-settings and
 * applied ONLY to the popover window (never the normal app window).
 */
import { useCallback, useEffect, useState } from 'react';

export type ControllerTheme =
  | 'midnight'
  | 'terminal'
  | 'editor'
  | 'paper'
  | 'graphite'
  | 'chalk'
  | 'sepia'
  | 'dusk'
  | 'zinc'
  | 'sage'
  | 'ink'
  | 'gruvbox-soft-dark';
export type ControllerFont = 'mono' | 'system' | 'serif';

export interface ControllerAppearance {
  theme: ControllerTheme;
  /** Window opacity as a percent, 60–100. */
  opacity: number;
  font: ControllerFont;
  /**
   * Text scale as a percent, 80–150. Applied as the window's zoom factor rather
   * than a font-size: the popover's type sizes are Tailwind px utilities, so a
   * root font-size would move the body text and leave every header, glyph and
   * padding behind. Zoom scales the whole layout, titles included.
   */
  textScale: number;
}

export const THEMES: Array<{ id: ControllerTheme; label: string }> = [
  { id: 'midnight', label: 'Midnight' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor' },
  { id: 'paper', label: 'Paper' },
  // Discreet, low-saturation skins.
  { id: 'graphite', label: 'Graphite' },
  { id: 'chalk', label: 'Chalk' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'zinc', label: 'Zinc' },
  { id: 'sage', label: 'Sage' },
  { id: 'ink', label: 'Ink' },
  { id: 'gruvbox-soft-dark', label: 'Gruvbox' },
];

export const FONTS: Array<{ id: ControllerFont; label: string; stack: string }> = [
  {
    id: 'mono',
    label: 'Mono',
    stack:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
  },
  {
    id: 'system',
    label: 'System',
    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  { id: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif' },
];

export const OPACITY_STEPS = [100, 92, 85, 75] as const;
export const TEXT_SCALE_STEPS = [90, 100, 115, 130] as const;

export const DEFAULT_APPEARANCE: ControllerAppearance = {
  theme: 'midnight',
  opacity: 100,
  font: 'mono',
  textScale: 100,
};

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
  graphite: {
    '--nim-bg': '#1a1a1a',
    '--nim-bg-secondary': '#202020',
    '--nim-bg-tertiary': '#2a2a2a',
    '--nim-bg-hover': '#2f2f2f',
    '--nim-bg-selected': '#383838',
    '--nim-text': '#e0e0e0',
    '--nim-text-muted': '#9e9e9e',
    '--nim-border': '#333333',
    '--nim-primary': '#b0b0b0',
    '--nim-success': '#82a082',
    '--nim-warning': '#c9a86a',
    '--nim-error': '#c07a7a',
  },
  chalk: {
    '--nim-bg': '#fafafa',
    '--nim-bg-secondary': '#f0f0f0',
    '--nim-bg-tertiary': '#e6e6e6',
    '--nim-bg-hover': '#ececec',
    '--nim-bg-selected': '#e0e0e0',
    '--nim-text': '#222222',
    '--nim-text-muted': '#5c5c5c',
    '--nim-border': '#dcdcdc',
    '--nim-primary': '#4a4a4a',
    '--nim-success': '#5a7a5a',
    '--nim-warning': '#9a7a3a',
    '--nim-error': '#a04a4a',
  },
  sepia: {
    '--nim-bg': '#f4ecd8',
    '--nim-bg-secondary': '#ece3cc',
    '--nim-bg-tertiary': '#e3d8bd',
    '--nim-bg-hover': '#e6dcc0',
    '--nim-bg-selected': '#dccdae',
    '--nim-text': '#5b4636',
    '--nim-text-muted': '#7a6350',
    '--nim-border': '#ddd0b4',
    '--nim-primary': '#a4703c',
    '--nim-success': '#6f7a3a',
    '--nim-warning': '#b08a3a',
    '--nim-error': '#a85438',
  },
  dusk: {
    '--nim-bg': '#23272e',
    '--nim-bg-secondary': '#1c2027',
    '--nim-bg-tertiary': '#2b303a',
    '--nim-bg-hover': '#2f353f',
    '--nim-bg-selected': '#353f4d',
    '--nim-text': '#c5ccd6',
    '--nim-text-muted': '#8b93a1',
    '--nim-border': '#2f353f',
    '--nim-primary': '#7e93ad',
    '--nim-success': '#7f9c82',
    '--nim-warning': '#c2a878',
    '--nim-error': '#bf8080',
  },
  zinc: {
    '--nim-bg': '#18181b',
    '--nim-bg-secondary': '#131316',
    '--nim-bg-tertiary': '#232327',
    '--nim-bg-hover': '#27272a',
    '--nim-bg-selected': '#303035',
    '--nim-text': '#e4e4e7',
    '--nim-text-muted': '#a1a1aa',
    '--nim-border': '#27272a',
    '--nim-primary': '#8a9bb0',
    '--nim-success': '#7d9a86',
    '--nim-warning': '#c1a877',
    '--nim-error': '#bd8181',
  },
  sage: {
    '--nim-bg': '#f3f4f0',
    '--nim-bg-secondary': '#e9ebe4',
    '--nim-bg-tertiary': '#dfe2d8',
    '--nim-bg-hover': '#e4e6dd',
    '--nim-bg-selected': '#d5d9cc',
    '--nim-text': '#3d423a',
    '--nim-text-muted': '#666c5f',
    '--nim-border': '#d8dccf',
    '--nim-primary': '#6f8a5f',
    '--nim-success': '#5f8a4f',
    '--nim-warning': '#9a7f3a',
    '--nim-error': '#a05446',
  },
  ink: {
    '--nim-bg': '#000000',
    '--nim-bg-secondary': '#0a0a0a',
    '--nim-bg-tertiary': '#141414',
    '--nim-bg-hover': '#1a1a1a',
    '--nim-bg-selected': '#242424',
    '--nim-text': '#d0d0d0',
    '--nim-text-muted': '#8a8a8a',
    '--nim-border': '#1a1a1a',
    '--nim-primary': '#a8a8a8',
    '--nim-success': '#6f9a72',
    '--nim-warning': '#b39a5a',
    '--nim-error': '#b06a6a',
  },
  'gruvbox-soft-dark': {
    '--nim-bg': '#32302f',
    '--nim-bg-secondary': '#282828',
    '--nim-bg-tertiary': '#3c3836',
    '--nim-bg-hover': '#3c3836',
    '--nim-bg-selected': '#504945',
    '--nim-text': '#ebdbb2',
    '--nim-text-muted': '#a89984',
    '--nim-border': '#3c3836',
    '--nim-primary': '#83a598',
    '--nim-success': '#98971a',
    '--nim-warning': '#d79921',
    '--nim-error': '#cc241d',
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

/** Apply the chosen font stack; index.css reads it through --nim-controller-font. */
export function applyControllerFont(font: ControllerFont): void {
  if (typeof document === 'undefined') return;
  const stack = (FONTS.find((f) => f.id === font) ?? FONTS[0]).stack;
  document.documentElement.style.setProperty('--nim-controller-font', stack, 'important');
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
  setFont: (font: ControllerFont) => void;
  setTextScale: (textScale: number) => void;
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
    applyControllerFont(appearance.font);
    void window.electronAPI?.invoke?.('controller-popover:set-opacity', appearance.opacity / 100);
    void window.electronAPI?.invoke?.('controller-popover:set-zoom', appearance.textScale / 100);
  }, [appearance.theme, appearance.opacity, appearance.font, appearance.textScale]);

  // One setter shape for every field: merge, persist, return.
  const update = useCallback((patch: Partial<ControllerAppearance>) => {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      void save(next);
      return next;
    });
  }, []);

  const setTheme = useCallback((theme: ControllerTheme) => update({ theme }), [update]);
  const setOpacity = useCallback((opacity: number) => update({ opacity }), [update]);
  const setFont = useCallback((font: ControllerFont) => update({ font }), [update]);
  const setTextScale = useCallback((textScale: number) => update({ textScale }), [update]);

  return { appearance, setTheme, setOpacity, setFont, setTextScale };
}
