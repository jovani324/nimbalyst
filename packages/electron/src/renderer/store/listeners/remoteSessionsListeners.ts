/**
 * Remote Sessions Listeners (controller mode)
 *
 * Central IPC listener for the Remote Sessions view. Subscribes ONCE at startup
 * to the broadcasts from the main-process RemoteSessionService and updates the
 * remoteSessions atoms. Components read atoms; they never subscribe to IPC
 * directly (see docs/IPC_LISTENERS.md).
 */

import { store } from '@nimbalyst/runtime/store';
import {
  applyRemoteIndexChangeAtom,
  appendRemoteMessageAtom,
  setRemoteConnectionStatusAtom,
} from '../atoms/remoteSessions';

let initialized = false;

export function initRemoteSessionsListeners(): () => void {
  if (initialized) return () => {};
  if (typeof window === 'undefined' || !window.electronAPI?.remoteSessions) {
    return () => {};
  }
  initialized = true;

  const api = window.electronAPI.remoteSessions;
  const cleanups: Array<() => void> = [];

  cleanups.push(
    api.onIndexChange(({ entry }) => {
      store.set(applyRemoteIndexChangeAtom, entry);
    }),
  );

  cleanups.push(
    api.onTranscriptChange(({ sessionId, change }) => {
      if (change.type === 'message_added') {
        store.set(appendRemoteMessageAtom, { sessionId, message: change.message });
      }
      // metadata_updated / session_deleted are reflected via the index-change
      // stream and the session list; no transcript mutation needed here.
    }),
  );

  cleanups.push(
    api.onStatusChange(({ sessionId, status }) => {
      store.set(setRemoteConnectionStatusAtom, { sessionId, connected: !!status?.connected });
    }),
  );

  return () => {
    initialized = false;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
  };
}
