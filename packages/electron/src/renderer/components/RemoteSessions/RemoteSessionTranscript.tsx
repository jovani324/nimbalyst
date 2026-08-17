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
import { resolvePendingPrompt } from './pendingPrompt';
import { RemoteCommitProposal, type CommitProposalResponse } from './RemoteCommitProposal';
import { ComposerImageStrip, useComposerImages } from './composerImages';
import { disguisedCode, disguisedName } from './controllerDisguise';
import { RemoteTerminalPane } from './RemoteTerminalPane';
import { toPayload } from './controllerImages';
import { useControllerPrivacy, AUTO_BLUR_IDLE_MS, type ControllerPrivacySettings } from './controllerPrivacy';
import {
  useControllerAppearance,
  THEMES,
  FONTS,
  OPACITY_STEPS,
  TEXT_SCALE_STEPS,
  type ControllerAppearance,
  type ControllerFont,
  type ControllerTheme,
} from './controllerAppearance';
import {
  type PermissionResponseContent,
  type AskUserQuestionResponseContent,
} from '@nimbalyst/runtime/ai/server/types';
import {
  projectRawMessagesToViewMessages,
  type RawMessage,
} from '@nimbalyst/runtime/ai/server/transcript';
import {
  remoteSessionsAtom,
  remoteTranscriptAtomFamily,
  remotePendingPromptAtomFamily,
} from '../../store/atoms/remoteSessions';

type ViewMessages = Awaited<ReturnType<typeof projectRawMessagesToViewMessages>>;

/** Borderless header action; index.css dims it until hover. Marker class first
 *  — an arbitrary-value Tailwind class in that slot breaks jsdom's :has() parse. */
const HEADER_ACTION_CLASS = 'remote-session-header-action text-[11px] px-1.5 py-0.5 rounded';

interface RemoteSessionTranscriptProps {
  sessionId: string;
  isActive: boolean;
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
  const composerImages = useComposerImages();
  const { images, clear: clearImages } = composerImages;
  const [sending, setSending] = useState(false);
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [masked, setMasked] = useState(false);
  const [showPrivacyMenu, setShowPrivacyMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paneHovered, setPaneHovered] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [pinned, setPinned] = useState(false);
  const transcriptPaneRef = useRef<HTMLDivElement>(null);
  const { settings: privacy, toggle: togglePrivacy } = useControllerPrivacy();
  const { appearance, setTheme, setOpacity, setFont, setTextScale } = useControllerAppearance();

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

  // Move through a long transcript without reaching for the trackpad. The
  // scroller lives inside CondensedRemoteTranscript, so it's found by class
  // rather than threaded out as a ref. Cmd/Ctrl+Up/Down jump to the ends;
  // PageUp/PageDown move a screen. Typing in the composer is left alone —
  // except for the jumps, which have no meaning in a one-line box.
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const el = transcriptPaneRef.current?.querySelector('.condensed-transcript') as HTMLElement | null;
      if (!el) return;
      const jump = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const page = Math.max(80, el.clientHeight - 40);

      if (jump && (e.key === 'ArrowUp' || e.key === 'Home')) {
        e.preventDefault();
        el.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (jump && (e.key === 'ArrowDown' || e.key === 'End')) {
        e.preventDefault();
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else if (!typing && e.key === 'PageUp') {
        e.preventDefault();
        el.scrollBy({ top: -page, behavior: 'smooth' });
      } else if (!typing && e.key === 'PageDown') {
        e.preventDefault();
        el.scrollBy({ top: page, behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive]);

  // The pin lives in the main process (it changes how the window answers blur
  // and Esc) and persists across restarts, so the button reflects that state
  // rather than owning it.
  useEffect(() => {
    let live = true;
    void window.electronAPI?.invoke?.('controller-popover:get-pinned').then((res: unknown) => {
      if (live) setPinned((res as { pinned?: boolean } | undefined)?.pinned === true);
    });
    return () => {
      live = false;
    };
  }, []);

  const togglePinned = async () => {
    const next = !pinned;
    setPinned(next);
    const res = (await window.electronAPI?.invoke?.('controller-popover:set-pinned', next)) as
      | { pinned?: boolean }
      | undefined;
    if (res && typeof res.pinned === 'boolean') setPinned(res.pinned);
  };

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

  // See pendingPrompt.ts for why there are two sources and why the transcript wins.
  const syncedPending = useAtomValue(remotePendingPromptAtomFamily(sessionId));
  const pendingPrompt = useMemo(
    () => resolvePendingPrompt(viewMessages, syncedPending),
    [viewMessages, syncedPending],
  );

  const handleSend = async () => {
    const text = draft.trim();
    const api = window.electronAPI?.remoteSessions;
    if ((!text && images.length === 0) || !api) return;
    setSending(true);
    setActionError(null);
    try {
      // An image with no words still needs a prompt for the agent to act on.
      const prompt = text || 'Take a look at this image.';
      await api.sendPrompt(sessionId, prompt, images.length ? toPayload(images) : undefined);
      setDraft('');
      clearImages();
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

  const handleCommitResponse = async (proposalId: string, response: CommitProposalResponse) => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    setPromptSubmitting(true);
    setActionError(null);
    try {
      await api.respondPrompt(sessionId, {
        promptType: 'git_commit',
        promptId: proposalId,
        response: { ...response },
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to answer the commit proposal');
    } finally {
      setPromptSubmitting(false);
    }
  };

  const isExecuting = !!session?.isExecuting;
  const canSend = !sending && (!!draft.trim() || images.length > 0);
  // Whole-transcript blur (as opposed to per-message hover-reveal).
  const globalBlur = masked && !privacy.hoverReveal;
  // The disguise is the quieter cousin of the blur: a pane of plausible source
  // instead of an obviously-smeared one, dropped the moment you point at it.
  const disguised = privacy.disguiseTranscript && !paneHovered;
  const headerTitle = privacy.disguiseTitles
    ? disguisedName(sessionId)
    : session?.title || 'Session';

  // Force a fresh pull of this session's latest state (transcript + queued/pending
  // status): reconnect + full resync so the host re-broadcasts everything.
  const handleRefresh = async () => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    setRefreshing(true);
    try {
      await api.resync(sessionId);
    } catch {
      /* transient */
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };

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
      {/* Header. Deliberately understated: no bar of its own — no fill, no rule
          under it — and ghost actions plus a ghost title that only come up to
          full contrast on hover, so a glance at the popover reads as text
          rather than as a titlebar over a document. */}
      <div className="remote-session-transcript-header flex items-center justify-between px-2 h-8 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="remote-session-header-title text-[11px] truncate"
            style={{ color: 'var(--nim-text-muted)' }}
            data-testid="remote-session-header-title"
          >
            {headerTitle}
          </span>
          {isExecuting && (
            <span
              className="shrink-0 w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: 'var(--nim-success)' }}
              title="Running"
            />
          )}
        </div>
        <div className="flex items-center shrink-0 relative">
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: 'var(--nim-text-muted)' }}
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            data-testid="remote-session-refresh-button"
            title="Refresh — pull the latest state from the host"
          >
            {refreshing ? '…' : '⟳'}
          </button>
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: masked ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={() => setMasked((m) => !m)}
            data-testid="remote-session-mask-button"
            title={masked ? 'Reveal messages' : 'Blur messages for privacy'}
            aria-pressed={masked}
          >
            {masked ? '🙈' : '👁'}
          </button>
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: pinned ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={() => void togglePinned()}
            data-testid="remote-session-pin-button"
            title={
              pinned
                ? 'Pinned — stays open when you click away. The boss-key still hides it.'
                : 'Pin open — stop the popover hiding when focus leaves'
            }
            aria-label="Pin the popover open"
            aria-pressed={pinned}
          >
            {pinned ? '\u25C9' : '\u25CB'}
          </button>
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: showTerminal ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={() => setShowTerminal((t) => !t)}
            data-testid="remote-session-terminal-button"
            title="Open a shell on the host, in this session's directory"
            aria-label="Open a shell on the host"
            aria-pressed={showTerminal}
          >
            {'>_'}
          </button>
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: showPrivacyMenu ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={() => setShowPrivacyMenu((s) => !s)}
            data-testid="remote-session-privacy-button"
            title="Appearance and privacy settings"
          >
            ⚙
          </button>
          {showPrivacyMenu && (
            <ControllerSettingsMenu
              settings={privacy}
              onToggle={togglePrivacy}
              appearance={appearance}
              onTheme={setTheme}
              onOpacity={setOpacity}
              onFont={setFont}
              onTextScale={setTextScale}
              onClose={() => setShowPrivacyMenu(false)}
            />
          )}
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: copiedAll ? 'var(--nim-success)' : 'var(--nim-text-muted)' }}
            onClick={() => void handleCopyMarkdown()}
            disabled={viewMessages.length === 0}
            data-testid="remote-session-copy-md-button"
            title="Copy the whole session as Markdown"
            aria-label="Copy the whole session as Markdown"
          >
            {copiedAll ? '✓' : '⧉'}
          </button>
          <button
            className={HEADER_ACTION_CLASS}
            style={{ color: 'var(--nim-text-muted)' }}
            onClick={() => void handleOpenInEditor()}
            disabled={viewMessages.length === 0}
            data-testid="remote-session-open-editor-button"
            title="Open the session as a Markdown file in your editor"
            aria-label="Open the session as a Markdown file in your editor"
          >
            ↗
          </button>
          {isExecuting && (
            <button
              className={HEADER_ACTION_CLASS}
              style={{ color: 'var(--nim-error)' }}
              onClick={() => void handleCancel()}
              data-testid="remote-session-cancel-button"
              title="Stop the running agent"
              aria-label="Stop the running agent"
            >
              ■
            </button>
          )}
        </div>
      </div>

      {/* Transcript (optionally blurred for privacy — like a banking app). The
          eye toggles masking; with hover-reveal on, messages blur individually
          and reveal on hover, otherwise the whole transcript blurs and a click
          reveals it. Secret-looking strings are redacted independently. */}
      <div
        ref={transcriptPaneRef}
        className="flex-1 min-h-0 flex flex-col"
        style={{
          filter: globalBlur ? 'blur(7px)' : undefined,
          transition: 'filter 120ms ease',
          cursor: globalBlur ? 'pointer' : undefined,
        }}
        onClick={globalBlur ? () => setMasked(false) : undefined}
        onMouseEnter={() => setPaneHovered(true)}
        onMouseLeave={() => setPaneHovered(false)}
        title={globalBlur ? 'Click to reveal' : undefined}
      >
        {disguised ? (
          <DisguisedSource sessionId={sessionId} />
        ) : (
          <CondensedRemoteTranscript
            messages={viewMessages}
            isProcessing={isExecuting}
            redact={privacy.redactSecrets}
            perMessageBlur={masked && privacy.hoverReveal}
          />
        )}
      </div>

      {showTerminal && (
        <RemoteTerminalPane sessionId={sessionId} onClose={() => setShowTerminal(false)} />
      )}

      {/* Pending interactive prompt. InteractivePromptWidget is sized for the
          desktop's full-height transcript pane; a question with several options
          and long descriptions is taller than the whole controller popover. Cap
          it and scroll inside, so it can never squeeze the transcript above it
          out of existence. */}
      {pendingPrompt && (
        <div
          className="remote-session-pending-prompt px-4 py-2 border-t shrink-0 max-h-[45%] overflow-y-auto"
          style={{ borderColor: 'var(--nim-border)' }}
          data-testid="remote-session-pending-prompt"
        >
          {pendingPrompt.promptType === 'git_commit_proposal' ? (
            <RemoteCommitProposal
              content={pendingPrompt.content}
              isSubmitting={promptSubmitting}
              onRespond={(r) => void handleCommitResponse(pendingPrompt.content.proposalId, r)}
            />
          ) : (
            <InteractivePromptWidget
              promptType={pendingPrompt.promptType}
              content={pendingPrompt.content}
              onSubmitResponse={(r) => void handlePromptResponse(r)}
              onCancelQuestion={(r) => void handlePromptResponse(r)}
              isSubmitting={promptSubmitting}
            />
          )}
        </div>
      )}

      {/* The host says a prompt is open but nothing renderable reached us — an
          older host build, or a prompt type the controller can't answer. Say so
          instead of showing a session that silently refuses to move. */}
      {!pendingPrompt && session?.hasPendingPrompt && (
        <div
          className="remote-session-prompt-unavailable px-2 py-1 text-[11px] border-t shrink-0"
          style={{ borderColor: 'var(--nim-border)', color: 'var(--nim-warning)' }}
          data-testid="remote-session-prompt-unavailable"
        >
          Waiting for an answer the host didn't send over — answer it there, or ⟳ to re-check.
        </div>
      )}

      {(actionError || composerImages.error) && (
        <div className="px-2 py-1 text-xs shrink-0" style={{ color: 'var(--nim-error)' }}>
          {actionError ?? composerImages.error}
        </div>
      )}

      {/* Composer. Kept as quiet as the header: a single-line box, a short
          placeholder (the full hint lives in the tooltip) and a ghost send
          glyph instead of a filled button. */}
      <div className="remote-session-composer flex flex-col gap-1.5 px-2 py-2 border-t shrink-0" style={{ borderColor: 'var(--nim-border)' }}>
        <ComposerImageStrip {...composerImages} />
        <div className="flex items-end gap-1.5">
          <textarea
            className="flex-1 resize-none rounded px-2 py-1 text-[12px] outline-none"
            style={{
              background: 'var(--nim-bg-secondary)',
              color: 'var(--nim-text)',
              border: '1px solid var(--nim-border)',
              maxHeight: 160,
            }}
            rows={1}
            placeholder="Reply…"
            title="Shift+Enter to send · paste an image to attach"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            onPaste={(e) => void composerImages.handlePaste(e)}
            data-testid="remote-session-composer-input"
          />
          <button
            className="remote-session-send-button text-[13px] px-2 py-1 rounded shrink-0"
            style={{ color: canSend ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={() => void handleSend()}
            disabled={!canSend}
            data-testid="remote-session-send-button"
            title="Send (Shift+Enter)"
            aria-label="Send"
          >
            ↵
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The transcript's stand-in while the pointer is elsewhere: a numbered page of
 * source. Rendered in place of the real thing rather than over it, so nothing
 * real is in the DOM to leak through a screenshot or a stray scroll.
 */
function DisguisedSource({ sessionId }: { sessionId: string }) {
  const lines = useMemo(() => disguisedCode(sessionId), [sessionId]);
  return (
    <div
      className="remote-session-disguise flex-1 min-h-0 overflow-hidden px-3 py-3 text-[12px] leading-[1.5] select-none"
      style={{ color: 'var(--nim-text-muted)' }}
      data-testid="remote-session-disguise"
      aria-hidden="true"
    >
      {lines.map((line, i) => (
        <div key={i} className="flex gap-3">
          <span className="shrink-0 text-right" style={{ width: 22, opacity: 0.5 }}>
            {i + 1}
          </span>
          <span className="whitespace-pre">{line}</span>
        </div>
      ))}
    </div>
  );
}

/** Dropdown: appearance (theme + transparency) and privacy toggles. */
function ControllerSettingsMenu({
  settings,
  onToggle,
  appearance,
  onTheme,
  onOpacity,
  onFont,
  onTextScale,
  onClose,
}: {
  settings: ControllerPrivacySettings;
  onToggle: (key: keyof ControllerPrivacySettings) => void;
  appearance: ControllerAppearance;
  onTheme: (theme: ControllerTheme) => void;
  onOpacity: (opacity: number) => void;
  onFont: (font: ControllerFont) => void;
  onTextScale: (scale: number) => void;
  onClose: () => void;
}) {
  const rows: Array<{ key: keyof ControllerPrivacySettings; label: string }> = [
    { key: 'autoBlurOnUnfocus', label: 'Auto-blur when idle / unfocused' },
    { key: 'hoverReveal', label: 'Hover to reveal (per message)' },
    { key: 'redactSecrets', label: 'Redact secrets (keys, emails…)' },
    { key: 'disguiseTitles', label: 'Titles as file paths' },
    { key: 'disguiseTranscript', label: 'Transcript as source until hovered' },
  ];
  const heading = (text: string) => (
    <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--nim-text-muted)' }}>
      {text}
    </div>
  );
  return (
    <>
      <div className="privacy-menu-backdrop fixed inset-0 z-20" onClick={onClose} />
      <div
        className="privacy-menu absolute right-0 top-full mt-1 z-30 rounded p-1 text-xs"
        style={{ background: 'var(--nim-bg-secondary)', border: '1px solid var(--nim-border)', minWidth: 236 }}
        data-testid="remote-session-settings-menu"
      >
        {heading('Look')}
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className="px-2 py-1 rounded"
              style={{
                border: '1px solid var(--nim-border)',
                background: appearance.theme === t.id ? 'var(--nim-bg-selected)' : 'transparent',
                color: appearance.theme === t.id ? 'var(--nim-primary)' : 'var(--nim-text)',
              }}
              onClick={() => onTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
          <span style={{ color: 'var(--nim-text-muted)' }}>Font</span>
          {FONTS.map((f) => (
            <button
              key={f.id}
              className="controller-font-option px-2 py-0.5 rounded"
              style={{
                border: '1px solid var(--nim-border)',
                background: appearance.font === f.id ? 'var(--nim-bg-selected)' : 'transparent',
                color: appearance.font === f.id ? 'var(--nim-primary)' : 'var(--nim-text)',
                fontFamily: f.stack,
              }}
              onClick={() => onFont(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2 pb-1">
          <span style={{ color: 'var(--nim-text-muted)' }}>Text</span>
          {TEXT_SCALE_STEPS.map((s) => (
            <button
              key={s}
              className="controller-text-scale-option px-1.5 py-0.5 rounded"
              style={{
                border: '1px solid var(--nim-border)',
                background: appearance.textScale === s ? 'var(--nim-bg-selected)' : 'transparent',
                color: appearance.textScale === s ? 'var(--nim-primary)' : 'var(--nim-text)',
              }}
              onClick={() => onTextScale(s)}
              title={`Scale the whole popover to ${s}%`}
            >
              {s}%
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2 pb-1">
          <span style={{ color: 'var(--nim-text-muted)' }}>Opacity</span>
          {OPACITY_STEPS.map((o) => (
            <button
              key={o}
              className="px-1.5 py-0.5 rounded"
              style={{
                border: '1px solid var(--nim-border)',
                background: appearance.opacity === o ? 'var(--nim-bg-selected)' : 'transparent',
                color: appearance.opacity === o ? 'var(--nim-primary)' : 'var(--nim-text)',
              }}
              onClick={() => onOpacity(o)}
            >
              {o}%
            </button>
          ))}
        </div>
        {/* The popover is resizable by dragging its edges; this is the way back
            to the stock dimensions when a drag leaves it an odd shape. */}
        <div className="flex items-center gap-2 px-2 pb-1">
          <span style={{ color: 'var(--nim-text-muted)' }}>Size</span>
          <button
            className="controller-reset-size px-2 py-0.5 rounded"
            style={{ border: '1px solid var(--nim-border)', color: 'var(--nim-text)' }}
            onClick={() => void window.electronAPI?.invoke?.('controller-popover:reset-size')}
            data-testid="controller-reset-size-button"
            title="Back to the default popover size"
          >
            Reset to default
          </button>
        </div>
        <div className="my-1 h-px" style={{ background: 'var(--nim-border)' }} />
        {heading('Privacy')}
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
