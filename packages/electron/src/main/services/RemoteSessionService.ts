/**
 * RemoteSessionService — the controller-mode data layer.
 *
 * When this machine runs in controller mode (see SessionSyncConfig.controllerMode
 * and CONTROLLER_MODE_PHASE1.md), it acts like the mobile app: it owns no local
 * agent processes and instead drives sessions that live on the always-on HOST
 * desktop, over the personal E2E-encrypted sync channel.
 *
 * This service is the main-process bridge between the renderer's "Remote Sessions"
 * view and the shared `SyncProvider`. It is a THIN wrapper — every capability it
 * exposes already exists on the provider (the same wire protocol the Swift/Kotlin
 * apps speak). Its jobs are:
 *   1. Read: fetchIndex() for the session/project list; forward onIndexChange
 *      broadcasts to the renderer so the list stays live.
 *   2. Transcript: connect(sessionId) + forward onRemoteChange (message_added /
 *      metadata_updated) so the renderer can render the transcript live.
 *   3. Write: queue prompts, request session creation, and send session-control
 *      messages (cancel / archive / interactive-prompt responses) — all the
 *      things the phone can do, mirrored from MobileSessionControlHandler's
 *      RECEIVE side into a SEND side here.
 *
 * IMPORTANT: this service never runs host-role logic. It publishes nothing to the
 * index except prompts/drafts the user explicitly sends, exactly like mobile.
 *
 * Wire discipline (mirrors what the host expects — see MobileSessionControlHandler
 * and AIService.tryInitializeMobileSyncHandler):
 *   - We identify as `sentBy: 'mobile'` on control messages so the host treats us
 *     like a phone.
 *   - Queued-prompt IDs are plain UUIDs and MUST NOT start with `local-` (the host
 *     skips `local-` ids as echoes of its own local queue).
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import type {
  SessionControlMessage,
  CreateSessionRequest,
  CreateSessionResponse,
} from '@nimbalyst/runtime/sync';
import { getSyncProvider } from './SyncManager';
import { isControllerMode } from '../utils/store';
import { logger } from '../utils/logger';

const log = logger.main;

// Renderer event channels (main -> renderer).
export const REMOTE_SESSION_CHANNELS = {
  /** An index entry changed (session list live updates). */
  indexChange: 'remote-sessions:index-change',
  /** A transcript change for a connected session (message_added / metadata_updated). */
  transcriptChange: 'remote-sessions:transcript-change',
  /** Connection status for a session changed. */
  statusChange: 'remote-sessions:status-change',
  /** A create-session request we sent was answered by the host. */
  createResponse: 'remote-sessions:create-response',
} as const;

/** Prompt-response payload shapes accepted by the host (see MobileSessionControlHandler). */
export interface RemotePromptResponse {
  promptType:
    | 'ask_user_question'
    | 'exit_plan_mode'
    | 'tool_permission'
    | 'git_commit'
    | 'request_user_input';
  promptId: string;
  response: Record<string, unknown>;
}

interface RemoteSessionState {
  /** Whether the index subscription has been wired up (idempotent guard). */
  indexSubscribed: boolean;
  /** Cleanup for the index subscription. */
  cleanupIndex?: () => void;
  /** Cleanup for the create-session-response subscription. */
  cleanupCreateResponse?: () => void;
  /** Per-session transcript subscription cleanups, keyed by sessionId. */
  transcriptCleanups: Map<string, () => void>;
  /** Debounced disconnect timers, keyed by sessionId (StrictMode-safe teardown). */
  pendingDisconnects: Map<string, ReturnType<typeof setTimeout>>;
  /** Pending create-session requests awaiting a response, keyed by requestId. */
  pendingCreates: Map<string, (response: CreateSessionResponse) => void>;
}

const state: RemoteSessionState = {
  indexSubscribed: false,
  transcriptCleanups: new Map(),
  pendingDisconnects: new Map(),
  pendingCreates: new Map(),
};

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/** Resolve the provider, throwing a clear error if sync isn't ready / not controller mode. */
function requireProvider() {
  if (!isControllerMode()) {
    throw new Error('RemoteSessionService is only available in controller mode');
  }
  const provider = getSyncProvider();
  if (!provider) {
    throw new Error('Sync provider is not initialized yet');
  }
  return provider;
}

/**
 * Wire up the always-on subscriptions (index + create-response) exactly once.
 * Safe to call repeatedly; only the first call with a ready provider subscribes.
 * Called lazily from the IPC layer so we don't depend on init ordering.
 */
export function ensureRemoteSubscriptions(): boolean {
  if (state.indexSubscribed) return true;
  if (!isControllerMode()) return false;

  const provider = getSyncProvider();
  if (!provider) return false;

  if (provider.onIndexChange) {
    state.cleanupIndex = provider.onIndexChange((sessionId, entry) => {
      broadcast(REMOTE_SESSION_CHANNELS.indexChange, { sessionId, entry });
    });
  }

  if (provider.onCreateSessionResponse) {
    state.cleanupCreateResponse = provider.onCreateSessionResponse((response) => {
      const resolver = state.pendingCreates.get(response.requestId);
      if (resolver) {
        state.pendingCreates.delete(response.requestId);
        resolver(response);
      }
      broadcast(REMOTE_SESSION_CHANNELS.createResponse, response);
    });
  }

  state.indexSubscribed = true;
  log.info('[RemoteSessionService] Index + create-response subscriptions wired');
  return true;
}

/** Fetch the decrypted session/project index (the list the phone sees). */
export async function listRemoteSessions() {
  const provider = requireProvider();
  ensureRemoteSubscriptions();
  if (!provider.fetchIndex) {
    throw new Error('Sync provider does not support fetchIndex');
  }
  return provider.fetchIndex();
}

/**
 * Connect to a session room and stream its transcript to the renderer. The
 * provider's sync_response backfills history and onRemoteChange streams live
 * message_added / metadata_updated events. Idempotent per session.
 */
export async function connectRemoteSession(sessionId: string): Promise<void> {
  const provider = requireProvider();
  ensureRemoteSubscriptions();

  // Cancel any debounced disconnect: React StrictMode (dev) mounts the
  // transcript, unmounts it (scheduling a disconnect), then remounts. Cancelling
  // here keeps the socket alive across that transient so it isn't torn down
  // mid-connect (which surfaced as an immediate 1006 + connect timeout).
  const pendingDisconnect = state.pendingDisconnects.get(sessionId);
  if (pendingDisconnect) {
    clearTimeout(pendingDisconnect);
    state.pendingDisconnects.delete(sessionId);
  }

  // Connect FIRST so the provider's per-session object exists. onRemoteChange /
  // onStatusChange attach to `session.changeListeners` and NO-OP when the
  // session isn't connected yet (CollabV3Sync.ts) — registering before connect
  // left the session with zero listeners, so the decrypted syncResponse backlog
  // was emitted to no one and the transcript stayed blank. The listeners are
  // registered synchronously after the await, before the syncResponse (a later
  // network macrotask) is processed, so no backlog is missed.
  await provider.connect(sessionId);
  ensureTranscriptListener(sessionId);
}

/**
 * Attach (or re-attach) the transcript + status listeners to the CURRENT
 * provider session object for `sessionId`. This MUST be idempotent and MUST run
 * against whatever session object exists right now:
 *
 * onRemoteChange/onStatusChange add callbacks to that object's listener sets. A
 * provider resubscribe after an index reconnect — or a socket drop — replaces
 * the session object, orphaning any listener attached to the old one. When that
 * happens the socket still receives the host's live `messageBroadcast`s, decrypts
 * them, and emits to an EMPTY listener set: the bytes arrive but nothing reaches
 * the renderer and the transcript silently stalls. So every connect AND every
 * resync re-asserts the listener here. Clearing the prior entry first keeps
 * already-attached reuse from stacking duplicates (a cleanup on a since-replaced
 * session is a harmless no-op).
 */
function ensureTranscriptListener(sessionId: string): void {
  const provider = getSyncProvider();
  if (!provider) return;
  const priorCleanup = state.transcriptCleanups.get(sessionId);
  if (priorCleanup) priorCleanup();
  const cleanupRemote = provider.onRemoteChange(sessionId, (change) => {
    if (change.type === 'message_added') {
      const m = change.message as { source?: string; direction?: string; content?: string };
      let info = `src=${m.source} dir=${m.direction} len=${m.content?.length ?? 0}`;
      try {
        const p = JSON.parse(String(m.content ?? '')) as {
          type?: string;
          subtype?: string;
          message?: { id?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
        };
        if (p.type === 'assistant' && Array.isArray(p.message?.content)) {
          const blocks = p.message!.content.map((b) => `${b.type}:${(b.text ?? b.thinking ?? '').length}`);
          info += ` assistantId=${p.message!.id} blocks=[${blocks.join(', ')}]`;
        } else {
          info += ` type=${p.type} sub=${p.subtype ?? ''}`;
        }
      } catch {
        info += ` (non-json)`;
      }
      log.info(`[CTRLDBG] msg ${sessionId} ${info}`);
    }
    broadcast(REMOTE_SESSION_CHANNELS.transcriptChange, { sessionId, change });
  });
  const cleanupStatus = provider.onStatusChange(sessionId, (status) => {
    broadcast(REMOTE_SESSION_CHANNELS.statusChange, { sessionId, status });
  });
  state.transcriptCleanups.set(sessionId, () => {
    cleanupRemote();
    cleanupStatus();
  });
}

/**
 * Disconnect a session room and drop its transcript subscription — DEBOUNCED.
 * A real navigation-away unmounts and never reconnects, so the teardown fires
 * after the delay. A StrictMode dev remount (connect→disconnect→connect) cancels
 * the pending teardown in connectRemoteSession, keeping the socket alive.
 */
export function disconnectRemoteSession(sessionId: string): void {
  const existing = state.pendingDisconnects.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.pendingDisconnects.delete(sessionId);
    const cleanup = state.transcriptCleanups.get(sessionId);
    if (cleanup) {
      cleanup();
      state.transcriptCleanups.delete(sessionId);
    }
    getSyncProvider()?.disconnect(sessionId);
  }, 1500);
  state.pendingDisconnects.set(sessionId, timer);
}

/**
 * Catch a session's transcript up to the host — reconnecting its room if the
 * socket silently dropped (session sockets don't auto-reconnect). The controller
 * calls this on window focus and a light poll so the viewed transcript never
 * goes stale between live pushes. Actively viewing also means "keep alive", so
 * cancel any debounced disconnect first.
 */
export async function resyncRemoteSession(sessionId: string): Promise<void> {
  const pendingDisconnect = state.pendingDisconnects.get(sessionId);
  if (pendingDisconnect) {
    clearTimeout(pendingDisconnect);
    state.pendingDisconnects.delete(sessionId);
  }
  const provider = getSyncProvider();
  if (!provider) return;

  // If the socket dropped, a full reconnect re-registers the listener and
  // re-syncs the whole backlog via onopen.
  if (!provider.isConnected(sessionId)) {
    await connectRemoteSession(sessionId);
    return;
  }

  // Socket is live. Re-assert our transcript listener FIRST: a provider
  // resubscribe (index reconnect) may have replaced the session object and
  // orphaned it, in which case live broadcasts have been silently landing on an
  // empty listener set. Then catch up on the open socket so anything missed
  // while the listener was detached is re-delivered to the now-attached listener.
  ensureTranscriptListener(sessionId);
  if (provider.resync) await provider.resync(sessionId);
}

/**
 * Queue a prompt on a remote session, mirroring the phone: push the prompt into
 * the session metadata (host inserts it into its queued_prompts table via
 * onIndexChange) then nudge the host's queue processor with a `prompt` control
 * message. The prompt id is a plain UUID (never `local-*`).
 */
export async function sendRemotePrompt(sessionId: string, prompt: string): Promise<string> {
  const provider = requireProvider();
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('Prompt is empty');
  }

  const promptId = randomUUID();
  const timestamp = Date.now();

  provider.pushChange(sessionId, {
    type: 'metadata_updated',
    metadata: {
      queuedPrompts: [{ id: promptId, prompt: trimmed, timestamp }],
    },
  });

  if (provider.sendSessionControlMessage) {
    await provider.sendSessionControlMessage({
      sessionId,
      type: 'prompt',
      payload: { promptId, prompt: trimmed },
      timestamp,
      sentBy: 'mobile',
    });
  }

  log.info('[RemoteSessionService] Sent remote prompt', { sessionId, promptId });
  return promptId;
}

/**
 * Ask the host to create a new session in one of its workspaces and (optionally)
 * kick it off with an initial prompt. Resolves with the host's response, which
 * carries the new sessionId on success.
 */
export async function createRemoteSession(request: {
  projectId: string;
  initialPrompt?: string;
  provider?: string;
  model?: string;
  sessionType?: string;
  parentSessionId?: string;
}): Promise<CreateSessionResponse> {
  const provider = requireProvider();
  ensureRemoteSubscriptions();
  if (!provider.sendCreateSessionRequest) {
    throw new Error('Sync provider does not support session creation requests');
  }

  const requestId = randomUUID();
  const payload: CreateSessionRequest = {
    requestId,
    projectId: request.projectId,
    initialPrompt: request.initialPrompt,
    provider: request.provider,
    model: request.model,
    sessionType: request.sessionType,
    parentSessionId: request.parentSessionId,
    timestamp: Date.now(),
  };

  const response = new Promise<CreateSessionResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingCreates.delete(requestId);
      reject(new Error('Timed out waiting for host to create session'));
    }, 30_000);
    state.pendingCreates.set(requestId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

  await provider.sendCreateSessionRequest(payload);
  log.info('[RemoteSessionService] Sent create-session request', { requestId, projectId: request.projectId });
  return response;
}

/** Send a raw session-control message to the host (internal helper). */
async function sendControl(message: Omit<SessionControlMessage, 'timestamp' | 'sentBy'>): Promise<void> {
  const provider = requireProvider();
  if (!provider.sendSessionControlMessage) {
    throw new Error('Sync provider does not support session control messages');
  }
  await provider.sendSessionControlMessage({
    ...message,
    timestamp: Date.now(),
    sentBy: 'mobile',
  });
}

/** Cancel the running agent on a remote session. */
export async function cancelRemoteSession(sessionId: string): Promise<void> {
  await sendControl({ sessionId, type: 'cancel' });
  log.info('[RemoteSessionService] Sent cancel', { sessionId });
}

/** Archive or unarchive a remote session. */
export async function archiveRemoteSession(sessionId: string, isArchived: boolean): Promise<void> {
  await sendControl({ sessionId, type: 'archive', payload: { isArchived } });
  log.info('[RemoteSessionService] Sent archive', { sessionId, isArchived });
}

/**
 * Respond to an interactive prompt (tool permission, plan-mode exit, question,
 * git commit, request-user-input) on a remote session. The payload shape per
 * promptType matches MobileSessionControlHandler.PromptResponsePayload.
 */
export async function respondToRemotePrompt(
  sessionId: string,
  response: RemotePromptResponse,
): Promise<void> {
  await sendControl({
    sessionId,
    type: 'prompt_response',
    payload: response as unknown as Record<string, unknown>,
  });
  log.info('[RemoteSessionService] Sent prompt_response', {
    sessionId,
    promptType: response.promptType,
    promptId: response.promptId,
  });
}

/** Tear down all subscriptions (called on sync reinit / controller-mode exit). */
export function shutdownRemoteSessionService(): void {
  state.cleanupIndex?.();
  state.cleanupCreateResponse?.();
  for (const timer of state.pendingDisconnects.values()) clearTimeout(timer);
  state.pendingDisconnects.clear();
  for (const cleanup of state.transcriptCleanups.values()) cleanup();
  state.transcriptCleanups.clear();
  state.pendingCreates.clear();
  state.indexSubscribed = false;
  log.info('[RemoteSessionService] Shut down');
}
