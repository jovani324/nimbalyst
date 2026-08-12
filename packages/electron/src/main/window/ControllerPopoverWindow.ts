/**
 * ControllerPopoverWindow — CTRL-05, the discreet menu-bar controller shell.
 *
 * A frameless, always-on-top popover anchored under the tray icon that hosts the
 * Phase 4 "Remote Sessions" UI (list + transcript + composer). Toggled by a tray
 * click or a global boss-key; hides on blur / Esc. The whole surface is gated on
 * `isControllerMode()` — on a normal host build none of this is created.
 *
 * The window loads the SAME renderer as the main window with `?controllerPopover=1`
 * so the renderer can open straight into remote-sessions mode and apply the
 * terminal skin (see index.css `[data-controller-popover]`).
 *
 * Dock/app-switcher hiding: `app.dock.hide()` is called from index.ts (guarded by
 * controller mode) for dev; packaged controller builds also set `LSUIElement` in
 * Info.plist (build-time — see CONTROLLER_MODE doc).
 */

import { app, BrowserWindow, globalShortcut, screen } from 'electron';
import { join } from 'path';
import { getPreloadPath } from '../utils/appPaths';
import { isControllerMode, store } from '../utils/store';
import { logger } from '../utils/logger';
import { TrayManager } from '../tray/TrayManager';

const POPOVER_BOUNDS_KEY = 'controllerPopoverBounds';

interface SavedPopoverBounds {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Remember where the user last dragged / how they last sized the popover. */
function savePopoverBounds(win: BrowserWindow): void {
  try {
    const { x, y, width, height } = win.getBounds();
    store.set(POPOVER_BOUNDS_KEY, { x, y, width, height });
  } catch {
    /* non-fatal */
  }
}

/** Restore the last position/size if the saved spot is still on a visible display. */
function restorePopoverBounds(win: BrowserWindow): boolean {
  try {
    const saved = store.get(POPOVER_BOUNDS_KEY) as SavedPopoverBounds | undefined;
    if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return false;
    // Only restore if the saved spot still lands on a real display (monitors change).
    const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
    const a = display.workArea;
    const width = clampSize(saved.width, POPOVER_MIN_WIDTH, a.width, win.getBounds().width);
    const height = clampSize(saved.height, POPOVER_MIN_HEIGHT, a.height, win.getBounds().height);
    const x = Math.max(a.x, Math.min(saved.x, a.x + a.width - width));
    const y = Math.max(a.y, Math.min(saved.y, a.y + a.height - height));
    win.setBounds({ x, y, width, height }, false);
    return true;
  } catch {
    return false;
  }
}

/** A stored dimension is only used when it's sane for the display it lands on. */
function clampSize(saved: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return fallback;
  return Math.round(Math.max(min, Math.min(saved, max)));
}

const POPOVER_WIDTH = 440;
const POPOVER_HEIGHT = 540;
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MIN_HEIGHT = 240;
const EDGE_PADDING = 8;
/** Gap between the menu bar / tray icon and the popover's top edge. */
const TRAY_GAP = 4;

/** Default boss-key; user-configurable (see setControllerBossKey). */
const DEFAULT_BOSS_KEY = 'Alt+Space';

let popoverWindow: BrowserWindow | null = null;
let registeredBossKey: string | null = null;

/** Build the renderer URL/file load call for the popover, mirroring the main window. */
function loadPopoverContent(win: BrowserWindow): void {
  const query = 'controllerPopover=1';
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html?${query}`);
  } else {
    const appPath = app.getAppPath();
    let htmlPath: string;
    if (app.isPackaged) {
      htmlPath = join(appPath, 'out/renderer/index.html');
    } else if (appPath.includes('/out/main') || appPath.includes('\\out\\main')) {
      htmlPath = join(appPath, '../renderer/index.html');
    } else {
      htmlPath = join(appPath, 'out/renderer/index.html');
    }
    void win.loadFile(htmlPath, { query: { controllerPopover: '1' } });
  }
}

/**
 * Create the popover window (hidden). Idempotent; no-op outside controller mode.
 */
export function createControllerPopover(): BrowserWindow | null {
  if (!isControllerMode()) return null;
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;

  popoverWindow = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    minWidth: POPOVER_MIN_WIDTH,
    minHeight: POPOVER_MIN_HEIGHT,
    show: false,
    frame: false,
    // Drag the edges to resize; the settings menu has a "Reset size" escape hatch
    // back to the default popover dimensions.
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A menu-bar popover should not steal a Space or animate like a normal window.
    transparent: false,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
    },
  });

  // Float above full-screen apps so the boss-key works from anywhere.
  popoverWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popoverWindow.setAlwaysOnTop(true, 'floating');

  loadPopoverContent(popoverWindow);

  // Hide (never destroy) on blur so the boss-key can re-show instantly, and so
  // alt-tabbing away dismisses it. Guard against the transient blur during show.
  popoverWindow.on('blur', () => {
    if (popoverWindow?.isVisible()) hideControllerPopover();
  });

  // Esc hides the popover.
  popoverWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      hideControllerPopover();
    }
  });

  // Remember where the user drags it and how they size it, so the next show
  // reopens exactly as they left it.
  popoverWindow.on('moved', () => {
    if (popoverWindow) savePopoverBounds(popoverWindow);
  });
  popoverWindow.on('resized', () => {
    if (popoverWindow) savePopoverBounds(popoverWindow);
  });

  popoverWindow.on('closed', () => {
    popoverWindow = null;
  });

  logger.main.info('[ControllerPopover] Created');
  return popoverWindow;
}

/** Position the popover just under the tray icon on the tray's display. */
function positionUnderTray(win: BrowserWindow): void {
  const trayBounds = TrayManager.getInstance().getTrayBounds();
  const [width, height] = win.getSize();

  if (trayBounds && trayBounds.width > 0) {
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const area = display.workArea;

    let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    // Clamp within the work area (handles right-edge / notched displays).
    x = Math.max(area.x + EDGE_PADDING, Math.min(x, area.x + area.width - width - EDGE_PADDING));

    // Below the menu bar: bottom of the tray icon plus a small gap, but never
    // above the work area top.
    const y = Math.max(area.y + EDGE_PADDING, trayBounds.y + trayBounds.height + TRAY_GAP);
    win.setPosition(x, y, false);
    return;
  }

  // Fallback: top-right of the display under the cursor.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const x = area.x + area.width - width - EDGE_PADDING;
  const y = area.y + EDGE_PADDING;
  win.setPosition(x, y, false);
}

/** Set the popover's window opacity (0.4–1) for the appearance transparency control. */
export function setControllerPopoverOpacity(opacity: number): void {
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    popoverWindow.setOpacity(Math.max(0.4, Math.min(1, opacity)));
  }
}

/**
 * Put the popover back to its default dimensions, keeping where it sits. The
 * stored size is rewritten so the next show doesn't restore the old one.
 */
export function resetControllerPopoverSize(): void {
  const win = popoverWindow;
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  win.setBounds(
    {
      x: Math.max(area.x, Math.min(x, area.x + area.width - POPOVER_WIDTH)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - POPOVER_HEIGHT)),
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
    },
    false,
  );
  savePopoverBounds(win);
}

/** Show the popover under the tray and focus its composer. */
export function showControllerPopover(): void {
  if (!isControllerMode()) return;
  const win = createControllerPopover();
  if (!win) return;
  // Reopen where the user last dragged/sized it; fall back to under the tray.
  if (!restorePopoverBounds(win)) positionUnderTray(win);
  win.show();
  win.focus();
  win.webContents.send('controller-popover:shown');
}

/** Hide the popover (kept alive for instant re-show). */
export function hideControllerPopover(): void {
  if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
    popoverWindow.hide();
    popoverWindow.webContents.send('controller-popover:hidden');
  }
}

/** Single toggle path shared by the tray click and the boss-key. */
export function toggleControllerPopover(): void {
  if (!isControllerMode()) return;
  if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
    hideControllerPopover();
  } else {
    showControllerPopover();
  }
}

/**
 * Register the global boss-key. Returns the accelerator actually registered, or
 * null if registration failed (e.g. the accelerator is taken by another app).
 */
export function registerControllerBossKey(accelerator: string = DEFAULT_BOSS_KEY): string | null {
  if (!isControllerMode()) return null;
  unregisterControllerBossKey();
  try {
    const ok = globalShortcut.register(accelerator, () => toggleControllerPopover());
    if (!ok) {
      logger.main.warn(`[ControllerPopover] Boss-key "${accelerator}" could not be registered (in use?)`);
      return null;
    }
    registeredBossKey = accelerator;
    logger.main.info(`[ControllerPopover] Boss-key registered: ${accelerator}`);
    return accelerator;
  } catch (err) {
    logger.main.warn('[ControllerPopover] Boss-key registration threw:', err);
    return null;
  }
}

/** Change the boss-key at runtime (user-configurable). */
export function setControllerBossKey(accelerator: string): string | null {
  return registerControllerBossKey(accelerator);
}

export function unregisterControllerBossKey(): void {
  if (registeredBossKey) {
    try {
      globalShortcut.unregister(registeredBossKey);
    } catch {
      /* ignore */
    }
    registeredBossKey = null;
  }
}

/** Tear down on quit: release the accelerator and destroy the window. */
export function destroyControllerPopover(): void {
  unregisterControllerBossKey();
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    popoverWindow.destroy();
  }
  popoverWindow = null;
}
