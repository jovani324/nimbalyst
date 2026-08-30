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

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { InteractivePromptWidget } from '@nimbalyst/runtime/ui/AgentTranscript/components/InteractivePromptWidget';
import { CondensedRemoteTranscript } from './CondensedRemoteTranscript';
import { buildSessionMarkdown } from './condensedTranscript';
import { resolvePendingPrompt } from './pendingPrompt';
import { RemoteCommitProposal, type CommitProposalResponse } from './RemoteCommitProposal';
import { ComposerImageStrip, useComposerImages } from './composerImages';
import {
  applyReplyStyle,
  nextReplyStyle,
  stripReplyStyle,
  REPLY_STYLE_LABELS,
  useControllerReplyStyle,
} from './controllerReplyStyle';
import { disguisedCode, disguisedName } from './controllerDisguise';
import {
  applyChoiceDirective,
  composeUtterance,
  nextSpeechMode,
  pickDigestTarget,
  shouldSpeak,
  SPEECH_MODE_LABELS,
  useControllerSpeech,
} from './controllerSpeech';
import type { SpeechDigest } from '@nimbalyst/runtime/ai/prompts/speechDigest';
import { RemoteTerminalPane } from './RemoteTerminalPane';
import { RemoteFileViewer } from './RemoteFileViewer';
import { NotesPanel } from '@nimbalyst/runtime/notes/NotesPanel';
import { useControllerNotes } from './controllerNotes';
import { toPayload } from './controllerImages';
import {
  useControllerPrivacy,
  AUTO_BLUR_IDLE_MS,
  REVEAL_MODES,
  type ControllerPrivacySettings,
  type ControllerRevealMode,
} from './controllerPrivacy';
import {
  useControllerAppearance,
  isTextSoap,
  isBuffer,
  isDisguiseLayout,
  THEMES,
  FONTS,
  OPACITY_STEPS,
  TEXT_SCALE_STEPS,
  type ControllerAppearance,
  type ControllerFont,
  type ControllerTheme,
} from './controllerAppearance';
import { TextSoapTranscript } from './TextSoapTranscript';
import { BufferTranscript } from './BufferTranscript';
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
  remoteSpeakingSessionIdAtom,
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
  const { replyStyle, setReplyStyle } = useControllerReplyStyle();
  const [compacting, setCompacting] = useState(false);
  const speech = useControllerSpeech();
  /** The newest digest, kept so its choices can be answered with a click. */
  const [digest, setDigest] = useState<{ messageId: string; digest: SpeechDigest } | null>(null);
  const digestedId = useRef<string | null>(null);
  // Throttle the reply-style directive: repeat it at most every N prompts, or
  // sooner when the style changes. 'default' as the seed makes the first
  // non-default prompt carry it.
  const STYLE_REPEAT_EVERY = 4;
  const styleGapRef = useRef(0);
  const lastStyleRef = useRef<string>('default');
  // Read at request time: switching the mode must not re-digest the same reply.
  const speechModeRef = useRef(speech.mode);
  speechModeRef.current = speech.mode;
  // Speak the session's own title before the digest so, with several sessions
  // reading at once, the ear knows which one is talking. The title is a local
  // label, not the host-anonymized digest, so naming it here leaks nothing.
  const readAloud = useCallback(
    (spoken: SpeechDigest) => {
      const label = session?.title?.trim();
      const body = composeUtterance(spoken);
      speech.speak(label ? `${label}. ${body}` : body);
    },
    [session, speech],
  );

  // Publish which session is talking so the list can mark it. Clear only if this
  // session still owns the flag, so a newer speaker is never wiped on cleanup.
  const setSpeakingSession = useSetAtom(remoteSpeakingSessionIdAtom);
  useEffect(() => {
    if (speech.isSpeaking) {
      setSpeakingSession(sessionId);
      return () => setSpeakingSession((prev) => (prev === sessionId ? null : prev));
    }
    setSpeakingSession((prev) => (prev === sessionId ? null : prev));
    return undefined;
  }, [speech.isSpeaking, sessionId, setSpeakingSession]);
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
  const [showNotes, setShowNotes] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  // A reply summary waiting to be dropped into a fresh note by the Notes panel.
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const notes = useControllerNotes();
  // The host's last reply, offered to the notes pane for a one-click clip.
  const noteClipText = useMemo(() => {
    for (let i = viewMessages.length - 1; i >= 0; i--) {
      const m = viewMessages[i];
      if (!m.toolCall && m.type !== 'user_message' && m.text?.trim()) return m.text;
    }
    return null;
  }, [viewMessages]);
  // Note -> session: land the text in the composer, never auto-send, and drop
  // back to the transcript so the user can review and send.
  const sendNoteToComposer = useCallback((text: string) => {
    if (!text) return;
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${text}` : text));
    setShowNotes(false);
  }, []);
  // ⌥N flips the notes pane from anywhere in the popover. (react's KeyboardEvent
  // type is imported above and shadows the DOM one, so name the global here.)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) {
        e.preventDefault();
        setShowNotes((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [openFile, setOpenFile] = useState<{ path: string; line?: number } | null>(null);
  // A picture cannot render in the source viewer, so it opens on the host's
  // default app. The bytes only exist over there; the popover machine may not
  // have them, so opening is the host's job just like reading is.
  const openExternalFile = useCallback(
    (path: string) => {
      setActionError(null);
      void window.electronAPI?.remoteSessions
        ?.openFile?.(sessionId, path)
        .then((res) => {
          if (res && !res.success) setActionError(res.error || 'The host could not open that file.');
        })
        .catch(() => setActionError('The host could not open that file.'));
    },
    [sessionId],
  );
  const [pinned, setPinned] = useState(false);
  const transcriptPaneRef = useRef<HTMLDivElement>(null);
  const { settings: privacy, toggle: togglePrivacy, set: setPrivacy } = useControllerPrivacy();
  const overlayRef = useRef<HTMLDivElement>(null);
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
        // Hide the reply-style directive the composer appends to outgoing
        // prompts. Strip it from the projected user text (not the raw
        // `{"prompt":...}` envelope, which JSON.parse must still unwrap).
        const cleaned = projected.map((m) =>
          m.type === 'user_message' && typeof m.text === 'string'
            ? { ...m, text: stripReplyStyle(m.text) }
            : m,
        );
        if (projectionToken.current === token) setViewMessages(cleaned);
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

  const isExecuting = !!session?.isExecuting;

  // Digest the final reply of each turn on the host and say it. The request
  // goes out whatever the mode, so a later switch to Speak has a cached digest
  // to read; only the playback obeys the mode.
  useEffect(() => {
    const api = window.electronAPI?.remoteSessions;
    const target = pickDigestTarget(viewMessages, isExecuting);
    if (!api?.speechDigest || !target || digestedId.current === target.id) return;
    digestedId.current = target.id;
    let live = true;
    void api
      .speechDigest(sessionId, target.id, target.text)
      .then((result) => {
        if (!live || !result.success) return;
        setDigest({ messageId: result.messageId, digest: result.digest });
        // Playback obeys the mode; the answer chips render whatever it is. Mute
        // stays fully silent -- no utterance and no chime.
        if (shouldSpeak(result.digest, speechModeRef.current)) readAloud(result.digest);
        else if (result.digest.kind === 'done' && speechModeRef.current !== 'off') speech.chime();
      })
      .catch(() => {
        /* a reply that cannot be digested is still on screen */
      });
    return () => {
      live = false;
    };
  }, [viewMessages, isExecuting, sessionId, speech, readAloud]);

  // Never keep talking into a room the user has turned away from: the popover
  // hiding blurs the window, and switching sessions deactivates this one.
  useEffect(() => {
    if (isActive) return;
    speech.hush();
  }, [isActive, speech]);
  useEffect(() => {
    window.addEventListener('blur', speech.hush);
    return () => window.removeEventListener('blur', speech.hush);
  }, [speech]);

  const sendText = async (prompt: string) => {
    const api = window.electronAPI?.remoteSessions;
    if (!api) return;
    setSending(true);
    setActionError(null);
    speech.hush();
    try {
      // The style directive is a per-prompt lever (a controller cannot set a
      // system prompt), but it costs ~80 tokens and every past copy replays in
      // history. Send it only when the style just changed or STYLE_REPEAT_EVERY
      // prompts have passed, so drift stays low without paying every turn. The
      // choice directive is cheap insurance at each decision, so it stays.
      const dueForStyle =
        replyStyle !== lastStyleRef.current || styleGapRef.current >= STYLE_REPEAT_EVERY;
      const styled = dueForStyle ? applyReplyStyle(prompt, replyStyle) : prompt.trim();
      if (dueForStyle) {
        lastStyleRef.current = replyStyle;
        styleGapRef.current = 0;
      } else {
        styleGapRef.current += 1;
      }
      await api.sendPrompt(
        sessionId,
        speech.mode === 'off' ? styled : applyChoiceDirective(styled),
        images.length ? toPayload(images) : undefined,
      );
      setDraft('');
      setDigest(null);
      clearImages();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to send prompt');
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text && images.length === 0) return;
    // An image with no words still needs a prompt for the agent to act on.
    await sendText(text || 'Take a look at this image.');
  };

  /**
   * Hand the draft to the host for a terse rewrite. The host has the `claude`
   * CLI and the checkout; this machine may have neither. The result lands back
   * in the composer for editing — compacting never sends.
   */
  const handleCompact = async () => {
    const text = draft.trim();
    const api = window.electronAPI?.remoteSessions;
    if (!text || !api?.compactPrompt || compacting) return;
    setCompacting(true);
    setActionError(null);
    try {
      const result = await api.compactPrompt(sessionId, text);
      if (result?.success) setDraft(result.text);
      else setActionError(result?.error ?? 'Failed to compact the draft');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to compact the draft');
    } finally {
      setCompacting(false);
    }
  };

  // Ask the host to summarize the last reply, drop it into a fresh note, and open
  // Notes — where the summary can be sent back to the composer to answer from.
  const handleSummarize = async () => {
    const api = window.electronAPI?.remoteSessions;
    const target = pickDigestTarget(viewMessages, isExecuting);
    if (!api?.summarizeReply || !target || summarizing) return;
    setSummarizing(true);
    setActionError(null);
    try {
      const result = await api.summarizeReply(sessionId, target.id, target.text);
      if (result?.success) {
        setPendingNote(result.summary);
        setShowNotes(true);
      } else {
        setActionError(result?.error ?? 'Could not summarize the reply.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not summarize the reply.');
    } finally {
      setSummarizing(false);
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

  const canSend = !sending && (!!draft.trim() || images.length > 0);
  // TextSoap and Buffer appearances swap the chat-style body + composer for a
  // full-surface disguise (a document, or a code-editor buffer). Any other
  // appearance keeps the normal transcript, so each disguise is fully reversible.
  const textsoap = isTextSoap(appearance.theme);
  const buffer = isBuffer(appearance.theme);
  const fullDisguise = textsoap || buffer;
  // Remember the last chat theme so cycling back from a disguise restores it.
  const lastChatThemeRef = useRef<ControllerTheme>('midnight');
  useEffect(() => {
    if (!isDisguiseLayout(appearance.theme)) lastChatThemeRef.current = appearance.theme;
  }, [appearance.theme]);
  // One-tap layout switch (header button): chat → TextSoap → Buffer → chat.
  const cycleLayout = () => {
    const next: ControllerTheme = textsoap ? 'buffer' : buffer ? lastChatThemeRef.current : 'textsoap';
    setTheme(next);
  };
  const layoutLabel = buffer ? 'buf' : textsoap ? 'soap' : 'chat';
  // Reveal mode governs how the transcript hides for a public glance. Disguise
  // (a page of plausible source, dropped when you point at the pane) is always on;
  // the blur modes act only while hidden — auto-hide on idle, or the eye toggle.
  const revealMode = privacy.revealMode;
  const disguised = revealMode === 'disguise' && !paneHovered;
  // Uniform lifts the whole pane as one on hover (no patchwork); reading-light
  // keeps it dim with a soft light around the cursor; per-message blurs each turn.
  const uniformBlur = masked && revealMode === 'uniform' && !paneHovered;
  const readingLight = masked && revealMode === 'reading-light';
  const perMessageBlur = masked && revealMode === 'per-message';
  // A click anywhere clears the mask for the whole-pane modes (per-message reveals
  // by hovering each turn instead).
  const clickToReveal = uniformBlur || readingLight;
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
    <div className="remote-session-transcript relative flex flex-col flex-1 min-h-0" data-testid="remote-session-transcript">
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
            style={{ color: fullDisguise ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            onClick={cycleLayout}
            data-testid="remote-session-layout-cycle"
            title="Switch layout: chat → TextSoap → Buffer"
          >
            {layoutLabel}
          </button>
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
          {/* The blur/eye toggle only makes sense for the chat themes — TextSoap
              and Buffer are their own disguise, so hide it there. */}
          {!fullDisguise && (
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
          )}
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
              onRevealMode={(m) => setPrivacy('revealMode', m)}
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
            onClick={() => void handleSummarize()}
            disabled={viewMessages.length === 0 || summarizing}
            data-testid="remote-session-summarize-button"
            title="Summarize the last reply into a new note"
            aria-label="Summarize the last reply into a new note"
          >
            {summarizing ? '…' : '≣'}
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
          reveals it. Secret-looking strings are redacted independently. In
          TextSoap / Buffer modes replace the body + composer with their own
          full-surface disguise below, so this pane is skipped. */}
      {!fullDisguise && (
        <div
          ref={transcriptPaneRef}
          className="flex-1 min-h-0 flex flex-col relative"
          style={{
            filter: uniformBlur ? 'blur(7px)' : undefined,
            transition: 'filter 200ms ease',
            cursor: clickToReveal ? 'pointer' : undefined,
          }}
          onClick={clickToReveal ? () => setMasked(false) : undefined}
          onMouseEnter={() => setPaneHovered(true)}
          onMouseLeave={() => {
            setPaneHovered(false);
            const ov = overlayRef.current;
            if (ov) {
              ov.style.setProperty('--mx', '-9999px');
              ov.style.setProperty('--my', '-9999px');
            }
          }}
          onMouseMove={
            readingLight
              ? (e) => {
                  const el = transcriptPaneRef.current;
                  const ov = overlayRef.current;
                  if (!el || !ov) return;
                  const r = el.getBoundingClientRect();
                  ov.style.setProperty('--mx', `${e.clientX - r.left}px`);
                  ov.style.setProperty('--my', `${e.clientY - r.top}px`);
                }
              : undefined
          }
          title={clickToReveal ? 'Click to reveal' : undefined}
        >
          {disguised ? (
            <DisguisedSource sessionId={sessionId} />
          ) : openFile ? (
            <RemoteFileViewer
              sessionId={sessionId}
              path={openFile.path}
              line={openFile.line}
              onClose={() => setOpenFile(null)}
            />
          ) : (
            <CondensedRemoteTranscript
              messages={viewMessages}
              isProcessing={isExecuting}
              redact={privacy.redactSecrets}
              perMessageBlur={perMessageBlur}
              onOpenFile={(path, line) => setOpenFile({ path, line })}
              onOpenExternalFile={openExternalFile}
            />
          )}
          {/* Reading light: a soft window that follows the cursor over an otherwise
              dimmed pane. pointer-events off so it never eats clicks. */}
          {readingLight && (
            <div
              ref={overlayRef}
              className="remote-session-reading-light absolute inset-0 pointer-events-none"
              style={{
                zIndex: 5,
                background:
                  'radial-gradient(circle at var(--mx, 50%) var(--my, 50%), transparent 0px, transparent 48px, color-mix(in srgb, var(--nim-bg) 94%, transparent) 132px)',
              }}
            />
          )}
        </div>
      )}

      {showTerminal && (
        <RemoteTerminalPane sessionId={sessionId} onClose={() => setShowTerminal(false)} />
      )}

      {/* Notes scratchpad. Full-height overlay that replaces the session region
          when the header toggle is on (mockup A). Kept mounted once loaded and
          only hidden when off, so a debounced save is never dropped by toggling
          away mid-keystroke; absolute so it never disturbs the transcript's
          layout underneath. Header is h-8 (2rem); sit just below it. */}
      {notes.ready && (
        <div
          className={`remote-session-notes-pane absolute left-0 right-0 flex flex-col${showNotes ? '' : ' hidden'}`}
          style={{ top: '2rem', bottom: 0, background: 'var(--nim-bg)' }}
          data-testid="remote-session-notes-pane"
        >
          <NotesPanel
            initialState={notes.initialState}
            onPersist={notes.persist}
            onSendToComposer={sendNoteToComposer}
            clipText={noteClipText}
            incomingNote={pendingNote}
            onIncomingNoteConsumed={() => setPendingNote(null)}
            onExit={() => setShowNotes(false)}
          />
        </div>
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

      {/* TextSoap appearance: document + cleaner sidebar in place of the chat
          composer. Reuses every send/style/speech/compact handler below. */}
      {textsoap && (
        <TextSoapTranscript
          messages={viewMessages}
          isExecuting={isExecuting}
          draft={draft}
          setDraft={setDraft}
          onSend={() => void handleSend()}
          onKeyDown={handleComposerKeyDown}
          canSend={canSend}
          sending={sending}
          replyStyle={replyStyle}
          onCycleReplyStyle={() => setReplyStyle(nextReplyStyle(replyStyle))}
          speechMode={speech.mode}
          onCycleSpeech={() => {
            speech.hush();
            speech.setMode(nextSpeechMode(speech.mode));
          }}
          onCompact={() => void handleCompact()}
          compacting={compacting}
          choices={digest && !isExecuting ? digest.digest.choices : []}
          onChoice={(prompt) => void sendText(prompt)}
          redact={privacy.redactSecrets}
        />
      )}

      {/* Buffer appearance: the transcript as a code-editor buffer. Same handlers. */}
      {buffer && (
        <BufferTranscript
          messages={viewMessages}
          isExecuting={isExecuting}
          draft={draft}
          setDraft={setDraft}
          onSend={() => void handleSend()}
          onKeyDown={handleComposerKeyDown}
          canSend={canSend}
          sending={sending}
          replyStyle={replyStyle}
          onCycleReplyStyle={() => setReplyStyle(nextReplyStyle(replyStyle))}
          speechMode={speech.mode}
          onCycleSpeech={() => {
            speech.hush();
            speech.setMode(nextSpeechMode(speech.mode));
          }}
          onCompact={() => void handleCompact()}
          compacting={compacting}
          choices={digest && !isExecuting ? digest.digest.choices : []}
          onChoice={(prompt) => void sendText(prompt)}
          redact={privacy.redactSecrets}
        />
      )}

      {/* Composer. Kept as quiet as the header: a single-line box, a short
          placeholder (the full hint lives in the tooltip) and a ghost send
          glyph instead of a filled button. */}
      {!fullDisguise && (
      <div className="remote-session-composer flex flex-col gap-1.5 px-2 py-2 border-t shrink-0" style={{ borderColor: 'var(--nim-border)' }}>
        <ComposerImageStrip {...composerImages} />
        {digest && (
          <div
            className="remote-session-speech-bar flex items-center gap-1.5 px-2 pb-1 text-[11px]"
            data-testid="remote-session-speech-bar"
          >
            <span
              className="shrink-0 font-medium"
              style={{ color: speech.isSpeaking ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
            >
              {speech.isSpeaking ? (speech.paused ? 'Paused' : 'Speaking…') : 'Ready'}
            </span>
            <span
              className="flex-1 truncate"
              style={{ color: 'var(--nim-text-muted)' }}
              title={digest.digest.spoken}
            >
              {digest.digest.spoken}
            </span>
            <button
              className="shrink-0 px-1.5 py-0.5 rounded"
              style={{ color: 'var(--nim-primary)', border: '1px solid var(--nim-border)' }}
              onClick={() => readAloud(digest.digest)}
              title="Read this reply aloud again"
              data-testid="remote-session-speech-replay"
            >
              Replay
            </button>
            {speech.isSpeaking && (
              <button
                className="shrink-0 px-1.5 py-0.5 rounded"
                style={{ color: 'var(--nim-primary)', border: '1px solid var(--nim-border)' }}
                onClick={() => (speech.paused ? speech.resume() : speech.pause())}
                title={speech.paused ? 'Resume playback' : 'Pause playback'}
                data-testid="remote-session-speech-pause"
              >
                {speech.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            {speech.isSpeaking && (
              <button
                className="shrink-0 px-1.5 py-0.5 rounded"
                style={{ color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
                onClick={() => speech.stop()}
                title="Stop playback"
                data-testid="remote-session-speech-stop"
              >
                Stop
              </button>
            )}
          </div>
        )}
        {digest && digest.digest.choices.length > 0 && !isExecuting && (
          <div className="remote-session-choices flex flex-wrap gap-1 px-2 pb-1" data-testid="remote-session-choices">
            {digest.digest.choices.map((choice, i) => (
              <button
                key={`${digest.messageId}-${i}`}
                className="remote-session-choice text-[11px] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--nim-primary)', border: '1px solid var(--nim-border)' }}
                onClick={() => void sendText(choice.prompt)}
                disabled={sending}
                title={choice.prompt}
              >
                {i + 1}. {choice.label}
              </button>
            ))}
          </div>
        )}
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
            title="Shift+Enter to send · paste an image to attach"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            onPaste={(e) => void composerImages.handlePaste(e)}
            data-testid="remote-session-composer-input"
          />
          <button
            className="remote-session-reply-style text-[11px] px-1.5 py-1 rounded shrink-0"
            style={{ color: replyStyle === 'default' ? 'var(--nim-text-muted)' : 'var(--nim-primary)' }}
            onClick={() => setReplyStyle(nextReplyStyle(replyStyle))}
            data-testid="remote-session-reply-style"
            title="How terse the agent should answer. Cycles Normal, Terse, Ultra."
          >
            {REPLY_STYLE_LABELS[replyStyle]}
          </button>
          <button
            className="remote-session-speech-mode text-[11px] px-1.5 py-1 rounded shrink-0"
            style={{ color: speech.mode === 'off' ? 'var(--nim-text-muted)' : 'var(--nim-primary)' }}
            onClick={() => {
              speech.hush();
              speech.setMode(nextSpeechMode(speech.mode));
            }}
            data-testid="remote-session-speech-mode"
            title="Read replies aloud. Cycles Mute, Speak when the agent needs you, Speak all."
          >
            {SPEECH_MODE_LABELS[speech.mode]}
          </button>
          <button
            className="remote-session-compact-button text-[11px] px-1.5 py-1 rounded shrink-0"
            style={{ color: 'var(--nim-text-muted)' }}
            onClick={() => void handleCompact()}
            disabled={compacting || sending || !draft.trim()}
            data-testid="remote-session-compact-button"
            title="Rewrite this draft into terse shorthand on the host. Does not send it."
          >
            {compacting ? '…' : 'Compact'}
          </button>
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
      )}

      {/* Bottom bar: the session/notes toggle lives here (not the header) so it
          reads as a quiet tab strip and stays reachable in both views. ⌥N flips
          it from anywhere. */}
      <div
        className="remote-session-tabbar flex items-center justify-center gap-1 border-t shrink-0"
        style={{ height: '1.75rem', borderColor: 'var(--nim-border)' }}
        data-testid="remote-session-tabbar"
      >
        <button
          className="text-[12px] px-2 rounded"
          style={{ color: !showNotes ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
          onClick={() => setShowNotes(false)}
          data-testid="remote-session-tab-session"
          title="Session transcript (⌥N)"
          aria-label="Session transcript"
          aria-pressed={!showNotes}
        >
          {'≡'}
        </button>
        <button
          className="text-[12px] px-2 rounded"
          style={{ color: showNotes ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
          onClick={() => setShowNotes(true)}
          data-testid="remote-session-notes-button"
          title="Scratchpad notes (⌥N)"
          aria-label="Scratchpad notes"
          aria-pressed={showNotes}
        >
          {'✎'}
        </button>
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
  onRevealMode,
  appearance,
  onTheme,
  onOpacity,
  onFont,
  onTextScale,
  onClose,
}: {
  settings: ControllerPrivacySettings;
  onToggle: (key: keyof ControllerPrivacySettings) => void;
  onRevealMode: (mode: ControllerRevealMode) => void;
  appearance: ControllerAppearance;
  onTheme: (theme: ControllerTheme) => void;
  onOpacity: (opacity: number) => void;
  onFont: (font: ControllerFont) => void;
  onTextScale: (scale: number) => void;
  onClose: () => void;
}) {
  // Only the boolean settings render as checkboxes; revealMode has its own picker.
  type BooleanPrivacyKey = 'autoBlurOnUnfocus' | 'redactSecrets' | 'disguiseTitles';
  const allRows: Array<{ key: BooleanPrivacyKey; label: string }> = [
    { key: 'autoBlurOnUnfocus', label: 'Auto-hide when idle / unfocused' },
    { key: 'redactSecrets', label: 'Redact secrets (keys, emails…)' },
    { key: 'disguiseTitles', label: 'Titles as file paths' },
  ];
  // TextSoap and Buffer are their own disguise, so the reveal modes and idle
  // auto-hide do nothing there — hide them. Redact + title-disguise stay.
  const textsoap = isDisguiseLayout(appearance.theme);
  const rows = textsoap ? allRows.filter((r) => r.key !== 'autoBlurOnUnfocus') : allRows;
  const heading = (text: string) => (
    <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--nim-text-muted)' }}>
      {text}
    </div>
  );
  // Fixed-width label gutter so every Look row's controls line up on one column.
  const lblStyle = { color: 'var(--nim-text-muted)', flex: '0 0 68px' };
  const renderPrivacyRow = (r: { key: BooleanPrivacyKey; label: string }) => (
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
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
          <span style={lblStyle}>Theme</span>
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
          <span style={lblStyle}>Font</span>
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
          <span style={lblStyle}>Text size</span>
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
          <span style={lblStyle}>Opacity</span>
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
        <div className="my-1 h-px" style={{ background: 'var(--nim-border)' }} />
        {heading('Privacy')}
        {!textsoap && (
          <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
            <span style={lblStyle}>Reveal</span>
            {REVEAL_MODES.map((m) => (
              <button
                key={m.id}
                className="controller-reveal-option px-2 py-0.5 rounded"
                style={{
                  border: '1px solid var(--nim-border)',
                  background: settings.revealMode === m.id ? 'var(--nim-bg-selected)' : 'transparent',
                  color: settings.revealMode === m.id ? 'var(--nim-primary)' : 'var(--nim-text)',
                }}
                onClick={() => onRevealMode(m.id)}
                title="How the transcript hides for a glance in public"
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
        {rows.map(renderPrivacyRow)}
        {/* Popover is drag-resizable; this returns it to stock dimensions. It
            changes the window, not the skin — so it sits in its own footer, not
            under Look next to the text-scale control. */}
        <div className="my-1 h-px" style={{ background: 'var(--nim-border)' }} />
        <div className="flex items-center justify-between px-2 pt-1 pb-1">
          <span style={lblStyle}>Window</span>
          <button
            className="controller-reset-size px-2 py-0.5 rounded"
            style={{ border: '1px solid var(--nim-border)', color: 'var(--nim-text)' }}
            onClick={() => void window.electronAPI?.invoke?.('controller-popover:reset-size')}
            data-testid="controller-reset-size-button"
            title="Back to the default popover size"
          >
            Reset size
          </button>
        </div>
      </div>
    </>
  );
}
