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
  setRemoteIndexAtom,
  setRemotePendingPromptAtom,
  type RemotePendingPromptData,
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

  // A live index-change for a session created on the host after our last full
  // fetch carries no projectId, so it lands under "Unknown project". When that
  // happens, re-fetch the full (decrypted) index — which does carry projectId —
  // to reclassify it. Debounced so a burst of changes triggers one refetch.
  let healTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleIndexHeal = () => {
    if (healTimer) return;
    healTimer = setTimeout(() => {
      healTimer = null;
      void (async () => {
        try {
          const index = await api.list();
          store.set(setRemoteIndexAtom, index);
        } catch {
          /* transient — a later change or manual refresh will retry */
        }
      })();
    }, 500);
  };

  cleanups.push(
    api.onIndexChange(({ entry }) => {
      const insertedUnknown = store.set(applyRemoteIndexChangeAtom, entry);
      if (insertedUnknown) scheduleIndexHeal();
    }),
  );

  cleanups.push(
    api.onTranscriptChange(({ sessionId, change }) => {
      if (change.type === 'message_added') {
        store.set(appendRemoteMessageAtom, { sessionId, message: change.message });
        return;
      }
      if (change.type === 'metadata_updated') {
        // The host syncs a pending tool-permission payload here so the controller
        // can render the approve UI (SDK sessions surface permissions only this
        // way). Only apply when the field is present: `null` clears, an object
        // sets, and `undefined` means "unrelated update" — leave it as-is.
        const metadata = (change as { metadata?: { pendingPromptData?: RemotePendingPromptData } }).metadata;
        if (metadata && 'pendingPromptData' in metadata) {
          store.set(setRemotePendingPromptAtom, { sessionId, data: metadata.pendingPromptData ?? null });
        }
      }
    }),
  );

  cleanups.push(
    api.onStatusChange(({ sessionId, status }) => {
      store.set(setRemoteConnectionStatusAtom, { sessionId, connected: !!status?.connected });
    }),
  );

  return () => {
    initialized = false;
    if (healTimer) {
      clearTimeout(healTimer);
      healTimer = null;
    }
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
  };
}
