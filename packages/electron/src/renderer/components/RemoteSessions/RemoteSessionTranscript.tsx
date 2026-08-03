/**
 * RemoteSessionTranscript — live transcript + composer for one remote session.
 *
 * Connects to the host's session room (over sync, via the main-process
 * RemoteSessionService), accumulates the raw AgentMessage stream into an atom,
 * projects it client-side into canonical TranscriptViewMessages (the exact same
 * pipeline the mobile apps use — no local DB), and renders it with the discreet
 * summary-first CondensedRemoteTranscript (with Copy-as-Markdown / open-in-editor
 * export). Pending interactive prompts (tool permissions, questions) are detected
 * from the stream and answered with InteractivePromptWidget, whose response is
 * relayed to the host as a `prompt_response` control message.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAtomValue } from 'jotai';
import { InteractivePromptWidget } from '@nimbalyst/runtime/ui/AgentTranscript/components/InteractivePromptWidget';
import { CondensedRemoteTranscript } from './CondensedRemoteTranscript';
import { buildSessionMarkdown } from './condensedTranscript';
import { useControllerPrivacy, AUTO_BLUR_IDLE_MS, type ControllerPrivacySettings } from './controllerPrivacy';
import {
  type PermissionRequestContent,
  type AskUserQuestionRequestContent,
  type PermissionResponseContent,
  type AskUserQuestionResponseContent,
} from '@nimbalyst/runtime/ai/server/types';
import {
  projectRawMessagesToViewMessages,
  type RawMessage,
  type TranscriptViewMessage,
} from '@nimbalyst/runtime/ai/server/transcript';
import {
  remoteSessionsAtom,
  remoteTranscriptAtomFamily,
  remotePendingPromptAtomFamily,
} from '../../store/atoms/remoteSessions';

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
 * Find a pending interactive prompt from the PROJECTED transcript. The projector
 * surfaces a provider-agnostic `interactivePrompt` payload on `interactive_prompt`
 * view messages (with requestId/status), which is the same representation the
 * desktop widgets use — and it works regardless of whether the underlying prompt
 * came from a persisted `permission_request` message or a synthetic ToolPermission
 * tool_use. (The old raw-content scan only matched the former, so it missed most
 * real prompts.) Returns the most recent still-pending request.
 */
function findPendingPrompt(viewMessages: TranscriptViewMessage[]): PendingPrompt {
  for (let i = viewMessages.length - 1; i >= 0; i--) {
    const vm = viewMessages[i];
    const p = vm.interactivePrompt;
    if (vm.type !== 'interactive_prompt' || !p || p.status !== 'pending') continue;

    if (p.promptType === 'permission_request') {
      return {
        promptType: 'permission_request',
        content: {
          type: 'permission_request',
          requestId: p.requestId,
          toolName: p.toolName,
          rawCommand: p.rawCommand,
          pattern: p.pattern,
          patternDisplayName: p.patternDisplayName,
          isDestructive: p.isDestructive,
          warnings: p.warnings,
          timestamp: 0,
          status: p.status,
        },
      };
    }
    if (p.promptType === 'ask_user_question') {
      return {
        promptType: 'ask_user_question_request',
        content: {
          type: 'ask_user_question_request',
          questionId: p.requestId,
          questions: p.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? '' })),
            multiSelect: q.multiSelect ?? false,
          })),
          timestamp: 0,
          status: p.status,
        },
      };
    }
    // git_commit_proposal and other types aren't answerable from the controller yet.
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
  const [copiedAll, setCopiedAll] = useState(false);
  const [masked, setMasked] = useState(false);
  const [showPrivacyMenu, setShowPrivacyMenu] = useState(false);
  const { settings: privacy, toggle: togglePrivacy } = useControllerPrivacy();

  // Auto-blur when you look away: mask on window blur, on the popover hiding, and
  // after an idle stretch. Any keypress/click/scroll resets the idle timer.
  useEffect(() => {
    if (!privacy.autoBlurOnUnfocus) return;
    const mask = () => setMasked(true);
    let idle = window.setTimeout(mask, AUTO_BLUR_IDLE_MS);
    const bump = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(mask, AUTO_BLUR_IDLE_MS);
    };
    const offHidden = window.electronAPI?.on?.('controller-popover:hidden', mask);
    window.addEventListener('blur', mask);
    window.addEventListener('keydown', bump, true);
    window.addEventListener('pointerdown', bump, true);
    window.addEventListener('wheel', bump, { passive: true });
    return () => {
      window.clearTimeout(idle);
      if (typeof offHidden === 'function') offHidden();
      window.removeEventListener('blur', mask);
      window.removeEventListener('keydown', bump, true);
      window.removeEventListener('pointerdown', bump, true);
      window.removeEventListener('wheel', bump);
    };
  }, [privacy.autoBlurOnUnfocus]);

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
    const poll = window.setInterval(resync, 4000);
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

  // Two sources for a pending prompt: (1) the projected transcript, which works
  // for sessions that write the prompt into the message stream (e.g. CLI), and
  // (2) a payload the host syncs via session metadata, which is the ONLY way SDK
  // tool-permissions reach a remote device. Prefer the transcript one; fall back
  // to the synced payload.
  const syncedPending = useAtomValue(remotePendingPromptAtomFamily(sessionId));
  const pendingPrompt = useMemo<PendingPrompt>(() => {
    const fromTranscript = findPendingPrompt(viewMessages);
    if (fromTranscript) return fromTranscript;
    if (syncedPending && syncedPending.promptType === 'permission_request') {
      return {
        promptType: 'permission_request',
        content: {
          type: 'permission_request',
          requestId: syncedPending.requestId,
          toolName: syncedPending.toolName,
          rawCommand: syncedPending.rawCommand,
          pattern: syncedPending.pattern,
          patternDisplayName: syncedPending.patternDisplayName,
          isDestructive: syncedPending.isDestructive,
          warnings: syncedPending.warnings,
          timestamp: 0,
          status: 'pending',
        },
      };
    }
    return null;
  }, [viewMessages, syncedPending]);

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
    // Shift+Enter sends; plain Enter inserts a newline.
    if (e.key === 'Enter' && e.shiftKey) {
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
  // Whole-transcript blur (as opposed to per-message hover-reveal).
  const globalBlur = masked && !privacy.hoverReveal;

  // Export the whole session as clean Markdown — copy to the clipboard, or write
  // it to a file and open it in the OS default editor.
  const handleCopyMarkdown = async () => {
    const md = buildSessionMarkdown(viewMessages, session?.title);
    await navigator.clipboard.writeText(md);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1200);
  };
  const handleOpenInEditor = async () => {
    const api = window.electronAPI?.remoteSessions;
    if (!api?.exportMarkdown) return;
    const md = buildSessionMarkdown(viewMessages, session?.title);
    setActionError(null);
    try {
      const res = await api.exportMarkdown(sessionId, session?.title, md);
      if (!res.success && res.error) setActionError(`Could not open export: ${res.error}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to export');
    }
  };

  return (
    <div className="remote-session-transcript flex flex-col flex-1 min-h-0" data-testid="remote-session-transcript">
      {/* Header */}
      <div
        className="remote-session-transcript-header flex items-center justify-between px-4 h-11 border-b shrink-0"
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
        <div className="flex items-center gap-1 shrink-0 relative">
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ color: masked ? 'var(--nim-primary)' : 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
            onClick={() => setMasked((m) => !m)}
            data-testid="remote-session-mask-button"
            title={masked ? 'Reveal messages' : 'Blur messages for privacy'}
            aria-pressed={masked}
          >
            {masked ? '🙈' : '👁'}
          </button>
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ color: showPrivacyMenu ? 'var(--nim-primary)' : 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
            onClick={() => setShowPrivacyMenu((s) => !s)}
            data-testid="remote-session-privacy-button"
            title="Privacy settings"
          >
            ⚙
          </button>
          {showPrivacyMenu && (
            <PrivacyMenu
              settings={privacy}
              onToggle={togglePrivacy}
              onClose={() => setShowPrivacyMenu(false)}
            />
          )}
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
            onClick={() => void handleCopyMarkdown()}
            disabled={viewMessages.length === 0}
            data-testid="remote-session-copy-md-button"
            title="Copy the whole session as Markdown"
          >
            {copiedAll ? 'Copied' : 'Copy MD'}
          </button>
          <button
            className="text-xs px-2 py-1 rounded"
            style={{ color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
            onClick={() => void handleOpenInEditor()}
            disabled={viewMessages.length === 0}
            data-testid="remote-session-open-editor-button"
            title="Open the session as a Markdown file in your editor"
          >
            Open
          </button>
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
      </div>

      {/* Transcript (optionally blurred for privacy — like a banking app). The
          eye toggles masking; with hover-reveal on, messages blur individually
          and reveal on hover, otherwise the whole transcript blurs and a click
          reveals it. Secret-looking strings are redacted independently. */}
      <div
        className="flex-1 min-h-0 flex flex-col"
        style={{
          filter: globalBlur ? 'blur(7px)' : undefined,
          transition: 'filter 120ms ease',
          cursor: globalBlur ? 'pointer' : undefined,
        }}
        onClick={globalBlur ? () => setMasked(false) : undefined}
        title={globalBlur ? 'Click to reveal' : undefined}
      >
        <CondensedRemoteTranscript
          messages={viewMessages}
          isProcessing={isExecuting}
          redact={privacy.redactSecrets}
          perMessageBlur={masked && privacy.hoverReveal}
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
          placeholder="Reply to the host…  (Shift+Enter to send)"
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

/** Small dropdown of on/off toggles for the controller's privacy features. */
function PrivacyMenu({
  settings,
  onToggle,
  onClose,
}: {
  settings: ControllerPrivacySettings;
  onToggle: (key: keyof ControllerPrivacySettings) => void;
  onClose: () => void;
}) {
  const rows: Array<{ key: keyof ControllerPrivacySettings; label: string }> = [
    { key: 'autoBlurOnUnfocus', label: 'Auto-blur when idle / unfocused' },
    { key: 'hoverReveal', label: 'Hover to reveal (per message)' },
    { key: 'redactSecrets', label: 'Redact secrets (keys, emails…)' },
  ];
  return (
    <>
      <div className="privacy-menu-backdrop fixed inset-0 z-20" onClick={onClose} />
      <div
        className="privacy-menu absolute right-0 top-full mt-1 z-30 rounded p-1 text-xs"
        style={{ background: 'var(--nim-bg-secondary)', border: '1px solid var(--nim-border)', minWidth: 224 }}
        data-testid="remote-session-privacy-menu"
      >
        {rows.map((r) => (
          <button
            key={r.key}
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:opacity-90"
            style={{ color: 'var(--nim-text)' }}
            onClick={() => onToggle(r.key)}
            aria-pressed={settings[r.key]}
          >
            <span style={{ color: settings[r.key] ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}>
              {settings[r.key] ? '☑' : '☐'}
            </span>
            <span className="flex-1">{r.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
