/**
 * IPC handlers for controller-mode Remote Sessions (see RemoteSessionService).
 *
 * Request/response channels:
 *   remote-sessions:list                 fetch decrypted session + project index
 *   remote-sessions:connect              connect a session room, start streaming its transcript
 *   remote-sessions:disconnect           stop streaming a session room
 *   remote-sessions:resync               catch a session transcript up (reconnect if the socket dropped)
 *   remote-sessions:export-markdown      write a session transcript to a .md file and open it
 *   remote-sessions:send-prompt          queue a prompt on a remote session
 *   remote-sessions:create               ask the host to create a new session
 *   remote-sessions:create-worktree      ask the host to cut a worktree + session
 *   remote-sessions:terminal             drive a shell the host opened for us
 *   remote-sessions:cancel               cancel the running agent on a remote session
 *   remote-sessions:archive              archive/unarchive a remote session
 *   remote-sessions:respond-prompt       answer an interactive prompt (permission/plan/question/...)
 *   remote-sessions:is-controller        whether this machine is in controller mode (gates the UI)
 *   controller-popover:set-opacity       window transparency for the popover
 *   controller-popover:set-zoom          text scale for the popover
 *   controller-popover:reset-size        put the popover back to its default dimensions
 *
 * Broadcasts (main -> renderer, see REMOTE_SESSION_CHANNELS):
 *   remote-sessions:index-change         a session index entry changed
 *   remote-sessions:transcript-change    a message/metadata change for a connected session
 *   remote-sessions:status-change        connection status changed
 *   remote-sessions:create-response      a create-session request was answered
 *   remote-sessions:terminal-event       output/lifecycle from a host shell
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { isControllerMode } from '../utils/store';
import {
  setControllerPopoverOpacity,
  setControllerPopoverZoom,
  resetControllerPopoverSize,
} from '../window/ControllerPopoverWindow';
import {
  listRemoteSessions,
  connectRemoteSession,
  disconnectRemoteSession,
  resyncRemoteSession,
  sendRemotePrompt,
  createRemoteSession,
  createRemoteWorktreeSession,
  sendRemoteTerminalControl,
  cancelRemoteSession,
  archiveRemoteSession,
  respondToRemotePrompt,
  ensureRemoteSubscriptions,
  type RemotePromptResponse,
  type RemotePromptImage,
} from '../services/RemoteSessionService';

export function registerRemoteSessionHandlers() {
  safeHandle('remote-sessions:is-controller', () => {
    return { controllerMode: isControllerMode() };
  });

  safeHandle('controller-popover:set-opacity', (_event, opacity: number) => {
    setControllerPopoverOpacity(typeof opacity === 'number' ? opacity : 1);
    return { ok: true };
  });

  safeHandle('controller-popover:set-zoom', (_event, scale: number) => {
    setControllerPopoverZoom(typeof scale === 'number' ? scale : 1);
    return { ok: true };
  });

  safeHandle('controller-popover:reset-size', () => {
    resetControllerPopoverSize();
    return { ok: true };
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

  safeHandle(
    'remote-sessions:export-markdown',
    async (_event, payload: { sessionId: string; title?: string; markdown: string }) => {
      if (!payload?.sessionId || typeof payload.markdown !== 'string') {
        throw new Error('remote-sessions:export-markdown requires sessionId and markdown');
      }
      const slug = (payload.title || 'session')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'session';
      const dir = path.join(app.getPath('temp'), 'nimbalyst-controller-exports');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${slug}-${payload.sessionId.slice(0, 8)}.md`);
      await fs.writeFile(filePath, payload.markdown, 'utf8');
      // shell.openPath returns '' on success, or an error string.
      const openError = await shell.openPath(filePath);
      return { success: !openError, filePath, error: openError || undefined };
    },
  );

  safeHandle(
    'remote-sessions:send-prompt',
    async (_event, payload: { sessionId: string; prompt: string; images?: RemotePromptImage[] }) => {
      if (!payload?.sessionId) {
        throw new Error('remote-sessions:send-prompt requires sessionId');
      }
      if (!payload?.prompt || !payload.prompt.trim()) {
        throw new Error('remote-sessions:send-prompt requires a non-empty prompt');
      }
      const promptId = await sendRemotePrompt(payload.sessionId, payload.prompt, payload.images);
      return { success: true, promptId };
    },
  );

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

  safeHandle('remote-sessions:create-worktree', async (_event, payload: { projectId: string }) => {
    if (!payload?.projectId) {
      throw new Error('remote-sessions:create-worktree requires projectId');
    }
    return createRemoteWorktreeSession(payload.projectId);
  });

  safeHandle(
    'remote-sessions:terminal',
    async (
      _event,
      payload: {
        sessionId: string;
        type: 'terminal_open' | 'terminal_input' | 'terminal_resize' | 'terminal_close';
        terminalId: string;
        data?: string;
        cols?: number;
        rows?: number;
      },
    ) => {
      if (!payload?.sessionId || !payload?.terminalId || !payload?.type) {
        throw new Error('remote-sessions:terminal requires sessionId, terminalId and type');
      }
      await sendRemoteTerminalControl(payload.sessionId, payload.type, {
        terminalId: payload.terminalId,
        ...(payload.data !== undefined ? { data: payload.data } : {}),
        ...(payload.cols !== undefined ? { cols: payload.cols } : {}),
        ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
      });
      return { success: true };
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
