/**
 * Notes core: types + a pure reducer, shared by every controller surface.
 *
 * No I/O and no clock. Actions that mint an id or a timestamp take them as
 * arguments so the reducer stays deterministic and unit-testable. Persistence
 * (localStorage in the standalone web controller, app-settings in the Electron
 * popover) and the React shell live elsewhere; this file is the whole state
 * machine.
 */

export type Accent = 'blue' | 'amber' | 'green' | 'pink';

export const ACCENTS: Accent[] = ['blue', 'amber', 'green', 'pink'];

export interface Note {
  id: string;
  title: string;
  body: string;
  accent: Accent;
  createdAt: number;
  updatedAt: number;
}

export interface NotesState {
  tabs: Note[];
  activeId: string | null;
}

export const emptyNotesState: NotesState = { tabs: [], activeId: null };

/**
 * A fresh pad. `title` starts blank; the panel shows a placeholder until the
 * first line is typed, which then becomes the tab label.
 */
export function makeNote(id: string, now: number, accent: Accent = 'blue'): Note {
  return { id, title: '', body: '', accent, createdAt: now, updatedAt: now };
}

export type NotesAction =
  | { type: 'add'; id: string; now: number; accent?: Accent }
  | { type: 'close'; id: string }
  | { type: 'select'; id: string }
  | { type: 'rename'; id: string; title: string; now: number }
  | { type: 'edit'; id: string; body: string; now: number }
  | { type: 'setAccent'; id: string; accent: Accent; now: number };

/** Label a tab from its first non-empty line, falling back to a stable stub. */
export function tabLabel(note: Note): string {
  const firstLine = note.body.split('\n').find((l) => l.trim().length > 0);
  const label = (note.title.trim() || firstLine || '').trim();
  return label.length > 0 ? label.slice(0, 24) : 'untitled';
}

function patch(state: NotesState, id: string, fn: (n: Note) => Note): NotesState {
  return { ...state, tabs: state.tabs.map((n) => (n.id === id ? fn(n) : n)) };
}

export function notesReducer(state: NotesState, action: NotesAction): NotesState {
  switch (action.type) {
    case 'add': {
      const note = makeNote(action.id, action.now, action.accent ?? 'blue');
      return { tabs: [...state.tabs, note], activeId: note.id };
    }
    case 'close': {
      const tabs = state.tabs.filter((n) => n.id !== action.id);
      if (state.activeId !== action.id) return { tabs, activeId: state.activeId };
      // Closing the active tab: fall back to the neighbor that took its slot,
      // or the last remaining tab, or nothing.
      const idx = state.tabs.findIndex((n) => n.id === action.id);
      const next = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1] ?? null;
      return { tabs, activeId: next ? next.id : null };
    }
    case 'select':
      return state.tabs.some((n) => n.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case 'rename':
      return patch(state, action.id, (n) => ({ ...n, title: action.title, updatedAt: action.now }));
    case 'edit':
      return patch(state, action.id, (n) => ({ ...n, body: action.body, updatedAt: action.now }));
    case 'setAccent':
      return patch(state, action.id, (n) => ({ ...n, accent: action.accent, updatedAt: action.now }));
    default:
      return state;
  }
}

export function activeNote(state: NotesState): Note | null {
  return state.tabs.find((n) => n.id === state.activeId) ?? null;
}

/** Reject anything that is not a well-formed NotesState; never throw. Used by */
/** every persistence adapter before it hands stored bytes to the reducer. */
export function coerceNotesState(raw: unknown): NotesState {
  if (!raw || typeof raw !== 'object') return emptyNotesState;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) return emptyNotesState;
  const tabs = obj.tabs
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      id: String(t.id ?? ''),
      title: typeof t.title === 'string' ? t.title : '',
      body: typeof t.body === 'string' ? t.body : '',
      accent: (ACCENTS.includes(t.accent as Accent) ? t.accent : 'blue') as Accent,
      createdAt: Number.isFinite(t.createdAt) ? (t.createdAt as number) : 0,
      updatedAt: Number.isFinite(t.updatedAt) ? (t.updatedAt as number) : 0,
    }))
    .filter((t) => t.id.length > 0);
  const activeId =
    typeof obj.activeId === 'string' && tabs.some((t) => t.id === obj.activeId)
      ? obj.activeId
      : (tabs[0]?.id ?? null);
  return { tabs, activeId };
}
