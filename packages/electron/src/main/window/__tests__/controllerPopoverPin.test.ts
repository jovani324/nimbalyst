// @vitest-environment node
/**
 * Pinning changes how the popover answers blur and Esc, which is the whole
 * reason the editor disguise is usable at all — an unpinned popover vanishes the
 * moment you click away, so nobody ever sees the camouflage. Both guards are
 * one-word conditions in event handlers, exactly the kind that get "simplified"
 * away later.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const storeData = new Map<string, unknown>();
const listeners = new Map<string, () => void>();
let inputHandler: ((event: unknown, input: { type: string; key: string }) => void) | null = null;
const hide = vi.fn();
const setAlwaysOnTop = vi.fn();

const fakeWindow = {
  isDestroyed: () => false,
  isVisible: () => true,
  hide,
  setAlwaysOnTop,
  setVisibleOnAllWorkspaces: vi.fn(),
  setBounds: vi.fn(),
  getBounds: () => ({ x: 0, y: 0, width: 440, height: 540 }),
  getSize: () => [440, 540],
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  on: (event: string, cb: () => void) => listeners.set(event, cb),
  once: vi.fn(),
  webContents: {
    on: (event: string, cb: typeof inputHandler) => {
      if (event === 'before-input-event') inputHandler = cb;
    },
    setZoomFactor: vi.fn(),
    send: vi.fn(),
  },
};

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', whenReady: async () => {} },
  BrowserWindow: function BrowserWindow() {
    return fakeWindow;
  },
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
vi.mock('../../utils/appPaths', () => ({ getPreloadPath: () => '/preload.js' }));
vi.mock('../../utils/store', () => ({
  isControllerMode: () => true,
  store: {
    get: (key: string) => storeData.get(key),
    set: (key: string, value: unknown) => storeData.set(key, value),
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));
vi.mock('../../tray/TrayManager', () => ({
  TrayManager: { getInstance: () => ({ getTrayBounds: () => null }) },
}));

const { createControllerPopover, setControllerPopoverPinned, isControllerPopoverPinned } =
  await import('../ControllerPopoverWindow');

createControllerPopover();

describe('controller popover pin', () => {
  beforeEach(() => {
    hide.mockClear();
    setAlwaysOnTop.mockClear();
    setControllerPopoverPinned(false);
  });

  it('hides on blur and on Esc when it is not pinned', () => {
    listeners.get('blur')?.();
    expect(hide).toHaveBeenCalledTimes(1);

    inputHandler?.({}, { type: 'keyDown', key: 'Escape' });
    expect(hide).toHaveBeenCalledTimes(2);
  });

  it('survives blur and Esc once pinned', () => {
    setControllerPopoverPinned(true);
    listeners.get('blur')?.();
    inputHandler?.({}, { type: 'keyDown', key: 'Escape' });
    expect(hide).not.toHaveBeenCalled();
  });

  it('stops floating above other windows while pinned', () => {
    // Always-on-top is itself a tell: no ordinary editor floats over everything.
    setControllerPopoverPinned(true);
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
    setControllerPopoverPinned(false);
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating');
  });

  it('persists the pin so it survives a restart', () => {
    setControllerPopoverPinned(true);
    expect(storeData.get('controllerPopoverPinned')).toBe(true);
    expect(isControllerPopoverPinned()).toBe(true);
  });
});
