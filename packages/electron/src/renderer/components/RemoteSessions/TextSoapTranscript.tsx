/**
 * TextSoap disguise for the remote-session transcript.
 *
 * Selected via the "TextSoap" controller appearance. Instead of the chat-style
 * transcript + composer, the session renders as a plain text-utility document:
 * each turn is a numbered paragraph with a pilcrow, and the composer is the last
 * paragraph — you type into the document itself. The AI controls (terseness,
 * speech, compact) live in the right-hand "cleaner" sidebar as custom cleaners,
 * and the agent's suggested follow-ups sit under CUSTOM as saved cleaners. The
 * decorative cleaners above the divider are real text transforms on the draft,
 * so a curious onlooker who clicks one sees a plausible result.
 *
 * This is a pure presentation shell: every send/style/speech/compact action is
 * the same handler the normal composer uses, passed in as props. Nothing here
 * talks to the host directly.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toParagraphs, TEXT_CLEANERS, type TextSoapPara } from './textSoapDocument';
import { redactSecrets } from './controllerPrivacy';
import { REPLY_STYLE_LABELS, type ReplyStyle } from './controllerReplyStyle';
import { SPEECH_MODE_LABELS, type SpeechMode } from './controllerSpeech';

interface Choice {
  label: string;
  prompt: string;
}

export interface TextSoapTranscriptProps {
  messages: TranscriptViewMessage[];
  isExecuting: boolean;
  draft: string;
  setDraft: (value: string | ((prev: string) => string)) => void;
  onSend: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  sending: boolean;
  replyStyle: ReplyStyle;
  onCycleReplyStyle: () => void;
  speechMode: SpeechMode;
  onCycleSpeech: () => void;
  onCompact: () => void;
  compacting: boolean;
  /** Suggested follow-ups (from the speech digest); empty while executing. */
  choices: Choice[];
  onChoice: (prompt: string) => void;
  /** Redact secret-looking strings (keys, emails) from the document text. */
  redact: boolean;
}

export function TextSoapTranscript({
  messages,
  isExecuting,
  draft,
  setDraft,
  onSend,
  onKeyDown,
  canSend,
  sending,
  replyStyle,
  onCycleReplyStyle,
  speechMode,
  onCycleSpeech,
  onCompact,
  compacting,
  choices,
  onChoice,
  redact,
}: TextSoapTranscriptProps) {
  const paragraphs = useMemo(() => {
    const paras = toParagraphs(messages);
    return redact ? paras.map((p) => ({ ...p, text: redactSecrets(p.text) })) : paras;
  }, [messages, redact]);
  const docRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+Alt + a letter/number jumps straight into the composer and types the
  // character there — no need to reach for the cursor. Derived from the physical
  // key (e.code) so macOS Option-key remapping doesn't turn letters into accents.
  useEffect(() => {
    const charFor = (e: globalThis.KeyboardEvent): string | null => {
      if (e.code.startsWith('Key')) {
        const l = e.code.slice(3).toLowerCase();
        return e.shiftKey ? l.toUpperCase() : l;
      }
      if (e.code === 'Space') return ' ';
      if (e.code.startsWith('Digit')) return e.code.slice(5);
      return null;
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      const el = composerRef.current;
      if (!el) return;
      const already = document.activeElement === el;
      const ch = charFor(e);
      if (ch !== null) {
        // Held Ctrl+Alt + a letter: focus and type the character in one go.
        e.preventDefault();
        if (!already) el.focus();
        setDraft((d) => d + ch);
      } else if (!already) {
        // Just Ctrl+Alt (or with a non-printable key): move focus so the next
        // keystrokes land in the composer even after the modifiers are released.
        el.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setDraft]);

  // Cleaner-sidebar width — draggable, persisted in app-settings so it survives
  // reloads. Clamped so it can't swallow the document or shrink to nothing.
  const [sidebarWidth, setSidebarWidth] = useState(208);
  const widthRef = useRef(208);
  widthRef.current = sidebarWidth;
  useEffect(() => {
    let live = true;
    void window.electronAPI
      ?.invoke?.('app-settings:get', 'controllerTextSoapSidebarWidth')
      .then((w) => {
        if (live && typeof w === 'number' && w >= 150 && w <= 420) setSidebarWidth(w);
      });
    return () => {
      live = false;
    };
  }, []);
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(Math.min(420, Math.max(150, startW - (ev.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      void window.electronAPI?.invoke?.('app-settings:set', 'controllerTextSoapSidebarWidth', widthRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Keep the composed line in view as turns arrive, like a document scrolled to
  // the caret. Runs on new turns and when the agent starts/stops.
  useEffect(() => {
    const el = docRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [paragraphs.length, isExecuting]);

  // Which tool asides are expanded to show their commands. Keyed by paragraph
  // index; the transcript is append-only so existing indices stay stable.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggleExpanded = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const composerLine = paragraphs.length + 1;
  // Your own prompts sit quietest — dimmer than the agent's reply, so a passing eye
  // lands on the answer, not the question. The agent's prose keeps its muted ink
  // (unchanged, the way it was); tool asides match it.
  const inkFor = (kind: TextSoapPara['kind']) =>
    kind === 'you'
      ? 'color-mix(in srgb, var(--nim-text-muted) 82%, var(--nim-bg))'
      : 'var(--nim-text-muted)';

  return (
    <div className="textsoap-transcript flex-1 min-h-0 flex" data-testid="textsoap-transcript">
      {/* Document */}
      <div
        ref={docRef}
        className="textsoap-document flex-1 min-h-0 overflow-y-auto py-2 select-text"
        style={{ background: 'var(--nim-bg)', fontFamily: 'var(--nim-controller-font)' }}
      >
        {paragraphs.map((p, i) => {
          const asideExpand = p.kind === 'aside' && !!p.details && p.details.length > 0;
          const replyCollapse = p.kind === 'assistant' && !!p.summary;
          const collapsible = asideExpand || replyCollapse;
          const open = expanded.has(i);
          const collapsed = replyCollapse && !open;
          const body = p.kind === 'aside' ? `// ${p.text}` : collapsed ? p.summary! : p.text;
          const hint = !collapsible
            ? undefined
            : asideExpand
              ? open
                ? 'Hide the commands that ran'
                : 'Show the commands that ran'
              : open
                ? 'Collapse this reply'
                : 'Show the full reply';
          return (
            <div key={i} className="textsoap-para flex items-start px-1 leading-relaxed">
              <span
                className="textsoap-linenum shrink-0 text-right pr-3 select-none text-[11px] pt-[2px]"
                style={{ width: 40, color: 'var(--nim-text-muted)', opacity: 0.55 }}
              >
                {i + 1}
              </span>
              <span
                className="textsoap-paratext flex-1 text-[12.5px]"
                style={{
                  color: inkFor(p.kind),
                  whiteSpace: 'pre-wrap',
                  fontStyle: p.kind === 'aside' ? 'italic' : undefined,
                  cursor: collapsible ? 'pointer' : undefined,
                }}
                onClick={collapsible ? () => toggleExpanded(i) : undefined}
                data-testid={collapsible ? 'textsoap-expand' : undefined}
                title={hint}
              >
                {body}
                {collapsed && !body.endsWith('…') && (
                  <span style={{ color: 'var(--nim-text-muted)', opacity: 0.7 }}> …</span>
                )}
                <span className="textsoap-pilcrow" style={{ color: 'var(--nim-primary)', opacity: 0.5, marginLeft: 2 }}>
                  ¶
                </span>
                {asideExpand && open && (
                  <span className="textsoap-tool-detail block mt-1" style={{ fontStyle: 'normal' }}>
                    {p.details!.map((d, di) => (
                      <span
                        key={di}
                        className="block"
                        style={{
                          fontFamily: 'ui-monospace, Menlo, Monaco, monospace',
                          fontSize: '11.5px',
                          color: 'var(--nim-text-muted)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {d}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </div>
          );
        })}

        {/* Composer — the live last paragraph */}
        <div className="textsoap-composer-para flex items-start px-1">
          <span
            className="textsoap-linenum shrink-0 text-right pr-3 select-none text-[11px] pt-[2px]"
            style={{ width: 40, color: 'var(--nim-primary)' }}
          >
            {composerLine}
          </span>
          <textarea
            ref={composerRef}
            className="textsoap-composer-input flex-1 resize-none bg-transparent outline-none text-[12.5px] leading-relaxed"
            style={{ color: 'var(--nim-text)', caretColor: 'var(--nim-primary)', maxHeight: 200, fontFamily: 'inherit' }}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="textsoap-composer-input"
          />
        </div>
      </div>

      {/* Drag handle — resize the cleaner sidebar. */}
      <div
        className="textsoap-resize shrink-0"
        style={{ width: 5, cursor: 'col-resize', background: 'var(--nim-border)', opacity: 0.5 }}
        onPointerDown={startResize}
        data-testid="textsoap-resize"
        title="Drag to resize"
      />

      {/* Cleaner sidebar */}
      <div
        className="textsoap-cleaners shrink-0 flex flex-col overflow-y-auto"
        style={{ width: sidebarWidth, background: 'var(--nim-bg-secondary)', borderLeft: '1px solid var(--nim-border)' }}
      >
        <div
          className="textsoap-preset mx-3 mt-3 mb-2 rounded text-center text-[12px] py-1"
          style={{ background: 'var(--nim-bg-selected)', color: '#fff' }}
        >
          Standard
        </div>
        <div
          className="textsoap-search mx-3 mb-1 rounded flex items-center gap-2 px-2 py-1 text-[12px]"
          style={{ background: 'var(--nim-bg-tertiary)', border: '1px solid var(--nim-border)', color: 'var(--nim-text-muted)' }}
        >
          <span>⌕</span>
          <span>Search</span>
        </div>

        <button
          className="textsoap-scrub text-left px-4 py-1.5 text-[13px] font-semibold flex items-center gap-2"
          style={{ color: canSend ? 'var(--nim-text)' : 'var(--nim-text-muted)' }}
          onClick={onSend}
          disabled={!canSend}
          data-testid="textsoap-scrub"
          title="Send this paragraph to the session"
        >
          Scrub<span className="ml-auto">🧹</span>
        </button>

        {TEXT_CLEANERS.map((c) => (
          <button
            key={c.label}
            className="textsoap-cleaner text-left px-4 py-1.5 text-[13px]"
            style={{ color: 'var(--nim-text)' }}
            onClick={() => setDraft(c.run(draft))}
            disabled={!draft.trim()}
          >
            {c.label}
          </button>
        ))}

        <div className="textsoap-divider mx-3 my-2" style={{ height: 1, background: 'var(--nim-border)' }} />
        <div className="textsoap-custom-label px-4 pb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--nim-text-muted)' }}>
          Custom
        </div>

        <button
          className="textsoap-concise text-left px-4 py-1.5 text-[13px] flex items-center"
          style={{ color: 'var(--nim-text)' }}
          onClick={onCycleReplyStyle}
          data-testid="textsoap-concise"
          title="How terse the agent answers"
        >
          Concise<span className="ml-auto text-[11px]" style={{ color: 'var(--nim-primary)' }}>{REPLY_STYLE_LABELS[replyStyle]}</span>
        </button>
        <button
          className="textsoap-readaloud text-left px-4 py-1.5 text-[13px] flex items-center"
          style={{ color: 'var(--nim-text)' }}
          onClick={onCycleSpeech}
          data-testid="textsoap-readaloud"
          title="Read replies aloud"
        >
          Read Aloud<span className="ml-auto text-[11px]" style={{ color: 'var(--nim-primary)' }}>{SPEECH_MODE_LABELS[speechMode]}</span>
        </button>
        <button
          className="textsoap-condense text-left px-4 py-1.5 text-[13px]"
          style={{ color: draft.trim() && !compacting ? 'var(--nim-text)' : 'var(--nim-text-muted)' }}
          onClick={onCompact}
          disabled={compacting || sending || !draft.trim()}
          data-testid="textsoap-condense"
          title="Rewrite the draft into terse shorthand — does not send"
        >
          {compacting ? 'Condensing…' : 'Condense Draft'}
        </button>

        {choices.map((c, i) => (
          <button
            key={`${i}-${c.label}`}
            className="textsoap-suggestion text-left px-4 py-1.5 text-[13px] flex items-center gap-2"
            style={{ color: 'var(--nim-text)' }}
            onClick={() => onChoice(c.prompt)}
            disabled={sending}
            title={c.prompt}
          >
            <span style={{ color: 'var(--nim-primary)' }}>▸</span>
            <span className="truncate">{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
