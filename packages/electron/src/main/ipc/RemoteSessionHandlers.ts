/**
 * IPC handlers for controller-mode Remote Sessions (see RemoteSessionService).
 *
 * Request/response channels:
 *   remote-sessions:list                 fetch decrypted session + project index
 *   remote-sessions:connect              connect a session room, start streaming its transcript
 *   remote-sessions:disconnect           stop streaming a session room
 *   remote-sessions:send-prompt          queue a prompt on a remote session
 *   remote-sessions:create               ask the host to create a new session
 *   remote-sessions:cancel               cancel the running agent on a remote session
 *   remote-sessions:archive              archive/unarchive a remote session
 *   remote-sessions:respond-prompt       answer an interactive prompt (permission/plan/question/...)
 *   remote-sessions:is-controller        whether this machine is in controller mode (gates the UI)
 *
 * Broadcasts (main -> renderer, see REMOTE_SESSION_CHANNELS):
 *   remote-sessions:index-change         a session index entry changed
 *   remote-sessions:transcript-change    a message/metadata change for a connected session
 *   remote-sessions:status-change        connection status changed
 *   remote-sessions:create-response      a create-session request was answered
 */

import { safeHandle } from '../utils/ipcRegistry';
import { isControllerMode } from '../utils/store';
import {
  listRemoteSessions,
  connectRemoteSession,
  disconnectRemoteSession,
  resyncRemoteSession,
  sendRemotePrompt,
  createRemoteSession,
  cancelRemoteSession,
  archiveRemoteSession,
  respondToRemotePrompt,
  ensureRemoteSubscriptions,
  type RemotePromptResponse,
} from '../services/RemoteSessionService';

export function registerRemoteSessionHandlers() {
  safeHandle('remote-sessions:is-controller', () => {
    return { controllerMode: isControllerMode() };
  });

  safeHandle('remote-sessions:list', async () => {
    return listRemoteSessions();
  });

  safeHandle('remote-sessions:connect', async (_event, payload: { sessionId: string }) => {
    if (!payload?.sessionId) {
      throw new Error('remote-sessions:connect requires sessionId');
    }
    await connectRemoteSession(payload.sessionId);
    return { success: true };
  });

  safeHandle('remote-sessions:disconnect', (_event, payload: { sessionId: string }) => {
    if (!payload?.sessionId) {
      throw new Error('remote-sessions:disconnect requires sessionId');
    }
    disconnectRemoteSession(payload.sessionId);
    return { success: true };
  });

  safeHandle('remote-sessions:resync', async (_event, payload: { sessionId: string }) => {
    if (!payload?.sessionId) {
      throw new Error('remote-sessions:resync requires sessionId');
    }
    await resyncRemoteSession(payload.sessionId);
    return { success: true };
  });

  safeHandle('remote-sessions:send-prompt', async (_event, payload: { sessionId: string; prompt: string }) => {
    if (!payload?.sessionId) {
      throw new Error('remote-sessions:send-prompt requires sessionId');
    }
    if (!payload?.prompt || !payload.prompt.trim()) {
      throw new Error('remote-sessions:send-prompt requires a non-empty prompt');
    }
    const promptId = await sendRemotePrompt(payload.sessionId, payload.prompt);
    return { success: true, promptId };
  });

  safeHandle(
    'remote-sessions:create',
    async (
      _event,
      payload: {
        projectId: string;
        initialPrompt?: string;
        provider?: string;
        model?: string;
        sessionType?: string;
        parentSessionId?: string;
      },
    ) => {
      if (!payload?.projectId) {
        throw new Error('remote-sessions:create requires projectId');
      }
      return createRemoteSession(payload);
    },
  );

  safeHandle('remote-sessions:cancel', async (_event, payload: { sessionId: string }) => {
    if (!payload?.sessionId) {
      throw new Error('remote-sessions:cancel requires sessionId');
    }
    await cancelRemoteSession(payload.sessionId);
    return { success: true };
  });

  safeHandle(
    'remote-sessions:archive',
    async (_event, payload: { sessionId: string; isArchived: boolean }) => {
      if (!payload?.sessionId) {
        throw new Error('remote-sessions:archive requires sessionId');
      }
      await archiveRemoteSession(payload.sessionId, payload.isArchived ?? true);
      return { success: true };
    },
  );

  safeHandle(
    'remote-sessions:respond-prompt',
    async (_event, payload: { sessionId: string; response: RemotePromptResponse }) => {
      if (!payload?.sessionId) {
        throw new Error('remote-sessions:respond-prompt requires sessionId');
      }
      if (!payload?.response?.promptType || !payload.response.promptId) {
        throw new Error('remote-sessions:respond-prompt requires a valid response');
      }
      await respondToRemotePrompt(payload.sessionId, payload.response);
      return { success: true };
    },
  );

  // In controller mode, wire up the live index/create subscriptions eagerly so
  // the renderer starts receiving index-change broadcasts as soon as the
  // provider is ready. No-op (and harmless) on a host desktop.
  if (isControllerMode()) {
    ensureRemoteSubscriptions();
  }
}
