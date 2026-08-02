/**
 * RemoteSessionTranscript — live transcript + composer for one remote session.
 *
 * Connects to the host's session room (over sync, via the main-process
 * RemoteSessionService), accumulates the raw AgentMessage stream into an atom,
 * projects it client-side into canonical TranscriptViewMessages (the exact same
 * pipeline the mobile apps use — no local DB), and renders it with the shared
 * RichTranscriptView. Pending interactive prompts (tool permissions, questions)
 * are detected from the stream and answered with InteractivePromptWidget, whose
 * response is relayed to the host as a `prompt_response` control message.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAtomValue } from 'jotai';
import { RichTranscriptView } from '@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView';
import { InteractivePromptWidget } from '@nimbalyst/runtime/ui/AgentTranscript/components/InteractivePromptWidget';
import {
  parseInteractivePromptContent,
  type PermissionRequestContent,
  type AskUserQuestionRequestContent,
  type PermissionResponseContent,
  type AskUserQuestionResponseContent,
} from '@nimbalyst/runtime/ai/server/types';
import {
  projectRawMessagesToViewMessages,
  type RawMessage,
} from '@nimbalyst/runtime/ai/server/transcript';
import { remoteSessionsAtom, remoteTranscriptAtomFamily } from '../../store/atoms/remoteSessions';
import type { RemoteAgentMessage } from '../../types/remoteSessions';

type ViewMessages = Awaited<ReturnType<typeof projectRawMessagesToViewMessages>>;

interface RemoteSessionTranscriptProps {
  sessionId: string;
  isActive: boolean;
}

/** The pending interactive prompt currently awaiting a response, if any. */
type PendingPrompt =
  | { promptType: 'permission_request'; content: PermissionRequestContent }
  | { promptType: 'ask_user_question_request'; content: AskUserQuestionRequestContent }
  | null;

/**
 * Scan the raw message stream for a request that has no matching response.
 * Requests and responses both sync as their own persisted messages
 * (docs/INTERACTIVE_PROMPTS.md), so we pair them by requestId/questionId.
 */
function findPendingPrompt(messages: RemoteAgentMessage[]): PendingPrompt {
  const respondedIds = new Set<string>();
  const requests: PendingPrompt[] = [];

  for (const msg of messages) {
    const parsed = parseInteractivePromptContent(msg.content);
    if (!parsed) continue;
    if (parsed.type === 'permission_response' || parsed.type === 'ask_user_question_response') {
      const id =
        parsed.type === 'permission_response'
          ? parsed.requestId
          : parsed.questionId;
      if (id) respondedIds.add(id);
    } else if (parsed.type === 'permission_request') {
      requests.push({ promptType: 'permission_request', content: parsed });
    } else if (parsed.type === 'ask_user_question_request') {
      requests.push({ promptType: 'ask_user_question_request', content: parsed });
    }
  }

  // Return the most recent request that is still pending and unresponded.
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i];
    if (!req) continue;
    const id =
      req.promptType === 'permission_request'
        ? req.content.requestId
        : req.content.questionId;
    if (req.content.status === 'pending' && !respondedIds.has(id)) {
      return req;
    }
  }
  return null;
}

export function RemoteSessionTranscript({ sessionId, isActive }: RemoteSessionTranscriptProps) {
  const rawMessages = useAtomValue(remoteTranscriptAtomFamily(sessionId));
  const sessions = useAtomValue(remoteSessionsAtom);
  const session = useMemo(
    () => sessions.find((s) => s.sessionId === sessionId),
    [sessions, sessionId],
  );
  const provider = session?.provider ?? rawMessages[0]?.source ?? 'claude-code';

  const [viewMessages, setViewMessages] = useState<ViewMessages>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Connect on mount / session change; disconnect on unmount. The component is
  // keyed by sessionId in the parent, so this maps 1:1 to the open session.
  useEffect(() => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    void api.connect(sessionId).catch((err) => {
      setActionError(err instanceof Error ? err.message : 'Failed to connect to session');
    });
    return () => {
      void api.disconnect(sessionId);
    };
  }, [sessionId]);

  // Keep the transcript from silently going stale. Session sockets don't
  // auto-reconnect on an unexpected drop the way the index does, so a dropped
  // socket would stop delivering live messages until the next manual connect.
  // Catch up (reconnecting if needed) whenever the user is likely looking — the
  // popover being shown, the window regaining focus, the tab becoming visible —
  // plus a light poll while this session is open as a safety net for a reply
  // that streams in on a socket that dropped while we were staring at it.
  useEffect(() => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    const resync = () => {
      void api.resync(sessionId).catch(() => {
        /* transient; the next tick retries */
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resync();
    };
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', onVisibility);
    const offPopoverShown = window.electronAPI?.on?.('controller-popover:shown', resync);
    const poll = window.setInterval(resync, 8000);
    return () => {
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', onVisibility);
      if (typeof offPopoverShown === 'function') offPopoverShown();
      window.clearInterval(poll);
    };
  }, [sessionId]);

  // Project the raw stream into canonical view messages whenever it changes.
  // Guarded against out-of-order async completion with a token ref.
  const projectionToken = useRef(0);
  useEffect(() => {
    const token = ++projectionToken.current;
    if (rawMessages.length === 0) {
      setViewMessages([]);
      return;
    }
    const raw: RawMessage[] = rawMessages.map((m, i) => ({
      id: m.id ?? i + 1,
      sessionId: m.sessionId,
      source: m.source,
      direction: m.direction,
      content: m.content,
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(0),
      metadata: m.metadata,
      hidden: m.hidden,
    }));
    void projectRawMessagesToViewMessages(raw, provider)
      .then((projected) => {
        if (projectionToken.current === token) setViewMessages(projected);
      })
      .catch(() => {
        /* projection failure leaves the last good render in place */
      });
  }, [rawMessages, provider]);

  const pendingPrompt = useMemo(() => findPendingPrompt(rawMessages), [rawMessages]);

  const handleSend = async () => {
    const text = draft.trim();
    const api = window.electronAPI?.remoteSessions;
    if (!text || !api) return;
    setSending(true);
    setActionError(null);
    try {
      await api.sendPrompt(sessionId, text);
      setDraft('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send prompt');
    } finally {
      setSending(false);
    }
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleCancel = async () => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    setActionError(null);
    try {
      await api.cancel(sessionId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel');
    }
  };

  const handlePromptResponse = async (
    response: PermissionResponseContent | AskUserQuestionResponseContent,
  ) => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    setPromptSubmitting(true);
    setActionError(null);
    try {
      if (response.type === 'permission_response') {
        await api.respondPrompt(sessionId, {
          promptType: 'tool_permission',
          promptId: response.requestId,
          response: { decision: response.decision, scope: response.scope },
        });
      } else {
        await api.respondPrompt(sessionId, {
          promptType: 'ask_user_question',
          promptId: response.questionId,
          response: { answers: response.answers, cancelled: response.cancelled ?? false },
        });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send response');
    } finally {
      setPromptSubmitting(false);
    }
  };

  const isExecuting = !!session?.isExecuting;

  return (
    <div className="remote-session-transcript flex flex-col flex-1 min-h-0" data-testid="remote-session-transcript">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 h-11 border-b shrink-0"
        style={{ borderColor: 'var(--nim-border)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--nim-text)' }}>
            {session?.title || 'Session'}
          </span>
          {isExecuting && (
            <span className="text-xs" style={{ color: 'var(--nim-success)' }}>
              running…
            </span>
          )}
        </div>
        {isExecuting && (
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ color: 'var(--nim-error)', border: '1px solid var(--nim-border)' }}
            onClick={() => void handleCancel()}
            data-testid="remote-session-cancel-button"
          >
            Stop
          </button>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <RichTranscriptView
          sessionId={sessionId}
          messages={viewMessages}
          provider={provider}
          isProcessing={isExecuting}
          hasPendingInteractivePrompt={!!pendingPrompt}
        />
      </div>

      {/* Pending interactive prompt */}
      {pendingPrompt && (
        <div className="px-4 py-2 border-t shrink-0" style={{ borderColor: 'var(--nim-border)' }}>
          <InteractivePromptWidget
            promptType={pendingPrompt.promptType}
            content={pendingPrompt.content}
            onSubmitResponse={(r) => void handlePromptResponse(r)}
            onCancelQuestion={(r) => void handlePromptResponse(r)}
            isSubmitting={promptSubmitting}
          />
        </div>
      )}

      {actionError && (
        <div className="px-4 py-1 text-xs shrink-0" style={{ color: 'var(--nim-error)' }}>
          {actionError}
        </div>
      )}

      {/* Composer */}
      <div className="remote-session-composer flex items-end gap-2 px-4 py-3 border-t shrink-0" style={{ borderColor: 'var(--nim-border)' }}>
        <textarea
          className="flex-1 resize-none rounded px-3 py-2 text-sm outline-none"
          style={{
            background: 'var(--nim-bg-secondary)',
            color: 'var(--nim-text)',
            border: '1px solid var(--nim-border)',
            maxHeight: 160,
          }}
          rows={2}
          placeholder="Send a message to this session on the host…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleComposerKeyDown}
          data-testid="remote-session-composer-input"
        />
        <button
          className="text-sm px-3 py-2 rounded shrink-0"
          style={{ background: 'var(--nim-primary)', color: '#fff', opacity: sending || !draft.trim() ? 0.5 : 1 }}
          onClick={() => void handleSend()}
          disabled={sending || !draft.trim()}
          data-testid="remote-session-send-button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
