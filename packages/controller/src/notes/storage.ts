/**
 * Notes persistence for the standalone web controller.
 *
 * The reducer and its validator live in the runtime; this is the localStorage
 * seam, which the controller is explicitly allowed to use (see config.ts). The
 * Electron popover supplies its own app-settings adapter instead.
 */
import { coerceNotesState, emptyNotesState, type NotesState } from '@nimbalyst/runtime/notes/model';

export interface NotesPersistence {
  load(): NotesState;
  save(state: NotesState): void;
}

export const NOTES_STORAGE_KEY = 'nimbalyst.notes.v1';

export function createLocalStoragePersistence(key = NOTES_STORAGE_KEY): NotesPersistence {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? coerceNotesState(JSON.parse(raw)) : emptyNotesState;
      } catch {
        // Corrupt JSON or a blocked store degrades to empty, never a crash.
        return emptyNotesState;
      }
    },
    save(state) {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* a full or blocked quota is not worth taking the panel down for */
      }
    },
  };
}
