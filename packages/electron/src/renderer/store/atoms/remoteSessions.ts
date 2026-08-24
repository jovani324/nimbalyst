/**
 * Remote Sessions Atoms (controller mode)
 *
 * Centralized state for the Remote Sessions view. Updated by
 * remoteSessionsListeners.ts in response to IPC events broadcast from the
 * main-process RemoteSessionService; components read from these atoms and never
 * subscribe to IPC directly (see docs/IPC_LISTENERS.md).
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type {
  RemoteSessionIndexEntry,
  RemoteProjectEntry,
  RemoteIndexChangeEntry,
  RemoteAgentMessage,
} from '../../types/remoteSessions';

/** The full decrypted session index (sessions the host owns). */
export const remoteSessionsAtom = atom<RemoteSessionIndexEntry[]>([]);

/** The decrypted project list (project picker source). */
export const remoteProjectsAtom = atom<RemoteProjectEntry[]>([]);

/** True once the initial index has been fetched at least once. */
export const remoteIndexLoadedAtom = atom<boolean>(false);

/** The session currently open in the transcript pane (or null for the list view). */
export const remoteActiveSessionIdAtom = atom<string | null>(null);

/**
 * The session whose digest is being read aloud right now, or null. Only one plays
 * at a time, so a single id is enough. Drives the discreet "speaking" dot in the
 * session list, so with several sessions the eye can match the voice to a row.
 */
export const remoteSpeakingSessionIdAtom = atom<string | null>(null);

/** Per-session accumulated raw transcript messages (as delivered by sync). */
export const remoteTranscriptAtomFamily = atomFamily((_sessionId: string) =>
  atom<RemoteAgentMessage[]>([]),
);

/** Per-session connection status. */
export const remoteConnectionStatusAtomFamily = atomFamily((_sessionId: string) =>
  atom<{ connected: boolean }>({ connected: false }),
);

/**
 * A pending interactive prompt synced from the host (via session metadata), so
 * the controller can render the answer UI and respond. Null when none.
 * SDK sessions surface permission requests and questions ONLY through this
 * channel (they don't write them into the transcript), so this is the
 * controller's source of truth for those.
 *
 * Mirrors SyncedPendingPromptData in main/services/ai/pendingPromptPersistence.ts.
 */
export type RemotePendingPromptData =
  | {
      promptType: 'permission_request';
      requestId: string;
      toolName: string;
      rawCommand: string;
      pattern: string;
      patternDisplayName: string;
      isDestructive: boolean;
      warnings: string[];
    }
  | {
      promptType: 'ask_user_question';
      questionId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
    }
  | {
      promptType: 'git_commit_proposal';
      proposalId: string;
      commitMessage: string;
      filesToStage: string[];
      reasoning?: string;
    }
  | null;

export const remotePendingPromptAtomFamily = atomFamily((_sessionId: string) =>
  atom<RemotePendingPromptData>(null),
);

/**
 * Store a pending prompt, but ONLY when it differs from the one already held.
 *
 * An unanswered prompt is re-delivered on every sync_response: the host's client
 * metadata still carries it and CollabV3Sync replays it so a device that joined
 * after the prompt was raised still sees it. The transcript view polls resync
 * every 4s, so an unanswered question re-arrives — freshly parsed, identical in
 * content, new object identity — every 4 seconds. Storing it unconditionally
 * re-rendered the whole transcript pane on that interval and rebuilt the answer
 * widget while the user was reading it.
 */
export const setRemotePendingPromptAtom = atom(
  null,
  (get, set, payload: { sessionId: string; data: RemotePendingPromptData }) => {
    const target = remotePendingPromptAtomFamily(payload.sessionId);
    if (samePendingPrompt(get(target), payload.data)) return;
    set(target, payload.data);
  },
);

/**
 * Structural equality for a pending prompt. Both sides are plain JSON decoded
 * from the same producer, so field order is stable and stringify is a faithful
 * (and cheap) comparison for payloads this small.
 */
function samePendingPrompt(a: RemotePendingPromptData, b: RemotePendingPromptData): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// === Derived selectors ===

/** Non-archived sessions grouped by projectId, each group sorted by recency. */
export const remoteSessionsByProjectAtom = atom((get) => {
  const sessions = get(remoteSessionsAtom);
  const groups = new Map<string, RemoteSessionIndexEntry[]>();
  for (const s of sessions) {
    if (s.isArchived) continue;
    const list = groups.get(s.projectId) ?? [];
    list.push(s);
    groups.set(s.projectId, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }
  return groups;
});

// === Write-only action atoms (used by the listener) ===

/** Replace the whole index (result of a fresh fetchIndex). */
export const setRemoteIndexAtom = atom(
  null,
  (get, set, payload: { sessions: RemoteSessionIndexEntry[]; projects: RemoteProjectEntry[] }) => {
    set(remoteSessionsAtom, payload.sessions);
    set(remoteProjectsAtom, payload.projects);
    set(remoteIndexLoadedAtom, true);
  },
);

/**
 * Merge a live index change into the session list. If the session is unknown
 * (created on the host after our last full fetch), it is inserted with the
 * fields we have; a subsequent full fetch fills in the rest.
 *
 * Returns `true` when it inserted a previously-unknown session — the listener
 * uses that signal to schedule a full index re-fetch, which fills in the
 * projectId so the session doesn't linger under "Unknown project".
 */
export const applyRemoteIndexChangeAtom = atom(
  null,
  (get, set, change: RemoteIndexChangeEntry): boolean => {
    const sessions = get(remoteSessionsAtom);
    const idx = sessions.findIndex((s) => s.sessionId === change.sessionId);
    if (idx === -1) {
      // Unknown session: insert a minimal entry. projectId is unknown until the
      // next full fetch; keep it empty so grouping puts it under "Unknown".
      set(remoteSessionsAtom, [
        {
          sessionId: change.sessionId,
          projectId: '',
          title: change.title ?? 'Untitled',
          provider: change.provider ?? 'unknown',
          model: change.model,
          mode: change.mode,
          messageCount: change.messageCount ?? 0,
          lastMessageAt: change.lastMessageAt ?? change.updatedAt ?? Date.now(),
          createdAt: change.updatedAt ?? Date.now(),
          updatedAt: change.updatedAt ?? Date.now(),
          pendingExecution: change.pendingExecution,
          isExecuting: change.isExecuting,
          hasPendingPrompt: change.hasPendingPrompt,
        },
        ...sessions,
      ]);
      return true;
    }
    const next = sessions.slice();
    const prev = next[idx];
    next[idx] = {
      ...prev,
      title: change.title ?? prev.title,
      provider: change.provider ?? prev.provider,
      model: change.model ?? prev.model,
      mode: change.mode ?? prev.mode,
      messageCount: change.messageCount ?? prev.messageCount,
      lastMessageAt: change.lastMessageAt ?? prev.lastMessageAt,
      updatedAt: change.updatedAt ?? prev.updatedAt,
      pendingExecution: 'pendingExecution' in change ? change.pendingExecution : prev.pendingExecution,
      isExecuting: change.isExecuting ?? prev.isExecuting,
      // Explicit `false` must win: it is how the host says the prompt was
      // answered, and `??` would keep the stale `true` forever.
      hasPendingPrompt: 'hasPendingPrompt' in change ? change.hasPendingPrompt : prev.hasPendingPrompt,
    };
    set(remoteSessionsAtom, next);
    return false;
  },
);

/** Append a raw message to a session's transcript, de-duplicating by providerMessageId/id. */
export const appendRemoteMessageAtom = atom(
  null,
  (get, set, payload: { sessionId: string; message: RemoteAgentMessage }) => {
    const { sessionId, message } = payload;
    const current = get(remoteTranscriptAtomFamily(sessionId));
    const key = (m: RemoteAgentMessage) => m.providerMessageId ?? (m.id != null ? `id:${m.id}` : undefined);
    const mk = key(message);
    if (mk && current.some((m) => key(m) === mk)) {
      return; // duplicate delivery
    }
    set(remoteTranscriptAtomFamily(sessionId), [...current, message]);
  },
);

/** Reset a session's accumulated transcript (e.g. before reconnecting). */
export const resetRemoteTranscriptAtom = atom(
  null,
  (get, set, sessionId: string) => {
    set(remoteTranscriptAtomFamily(sessionId), []);
  },
);

/** Update a session's connection status. */
export const setRemoteConnectionStatusAtom = atom(
  null,
  (get, set, payload: { sessionId: string; connected: boolean }) => {
    set(remoteConnectionStatusAtomFamily(payload.sessionId), { connected: payload.connected });
  },
);
