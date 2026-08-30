/**
 * Notes persistence for the Electron controller popover.
 *
 * The reducer, validator, and panel live in the runtime so every controller
 * shares one notes implementation; only storage differs. Here that is
 * app-settings, never localStorage -- same rule and same shape as
 * controllerReplyStyle / controllerAppearance.
 *
 * Notes are a single global scratchpad (one key, not per session), so the same
 * tabs follow you across every session you drive.
 */
import { useCallback, useEffect, useState } from 'react';
import { coerceNotesState, emptyNotesState, type NotesState } from '@nimbalyst/runtime/notes/model';

const KEY = 'controllerNotes';

export function useControllerNotes(): {
  ready: boolean;
  initialState: NotesState;
  persist: (state: NotesState) => void;
} {
  const [ready, setReady] = useState(false);
  const [initialState, setInitialState] = useState<NotesState>(emptyNotesState);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const stored = await window.electronAPI?.invoke?.('app-settings:get', KEY);
        if (live && stored) {
          const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
          setInitialState(coerceNotesState(parsed));
        }
      } catch {
        /* an unreadable or corrupt store just starts empty */
      } finally {
        // Gate the panel on ready so useReducer seeds from the stored state,
        // not from empty-then-hydrate (which would blow away tab one on load).
        if (live) setReady(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const persist = useCallback((state: NotesState) => {
    void window.electronAPI
      ?.invoke?.('app-settings:set', KEY, JSON.stringify(state))
      ?.catch?.(() => {
        /* non-fatal */
      });
  }, []);

  return { ready, initialState, persist };
}
