/**
 * Buffer disguise for the remote-session transcript.
 *
 * Selected via the "Buffer" controller appearance. Like TextSoap, it renders the
 * REAL transcript permanently dressed as something mundane — here, a code editor
 * with a file open. Your prompts are the green `+` added lines; the agent's
 * replies are `//` comment lines; tool runs fold into a `//` aside; the composer
 * is the last editable line. Terseness / speech / compact live in the bottom
 * status bar. There is no reveal flip and no fake static file: it is the real
 * conversation, so it scrolls and grows.
 *
 * A pure presentation shell — every send/style/speech/compact action is the same
 * handler the chat composer uses, passed in as props.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toParagraphs } from './textSoapDocument';
import { redactSecrets } from './controllerPrivacy';
import { REPLY_STYLE_LABELS, type ReplyStyle } from './controllerReplyStyle';
import { SPEECH_MODE_LABELS, type SpeechMode } from './controllerSpeech';

interface Choice {
  label: string;
  prompt: string;
}

export interface BufferTranscriptProps {
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
  choices: Choice[];
  onChoice: (prompt: string) => void;
  redact: boolean;
}

export function BufferTranscript({
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
}: BufferTranscriptProps) {
  const paragraphs = useMemo(() => {
    const paras = toParagraphs(messages);
    return redact ? paras.map((p) => ({ ...p, text: redactSecrets(p.text) })) : paras;
  }, [messages, redact]);
  const docRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+Alt (+ a letter) jumps into the composer without reaching for the cursor.
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
        e.preventDefault();
        if (!already) el.focus();
        setDraft((d) => d + ch);
      } else if (!already) {
        el.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setDraft]);

  // Which tool asides / long replies are expanded. Keyed by paragraph index.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggleExpanded = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  useEffect(() => {
    const el = docRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [paragraphs.length, isExecuting]);

  const lineFor = (n: number) => (
    <span
      className="buffer-linenum shrink-0 text-right pr-3 select-none text-[11px] pt-[1px]"
      style={{ width: 40, color: 'var(--nim-text-muted)', opacity: 0.5 }}
    >
      {n}
    </span>
  );

  let line = 0; // running line number across all rows

  return (
    <div className="buffer-transcript flex-1 min-h-0 flex flex-col" data-testid="buffer-transcript">
      <div
        ref={docRef}
        className="buffer-code flex-1 min-h-0 overflow-y-auto py-2 select-text"
        style={{ background: 'var(--nim-bg)', fontFamily: 'var(--nim-controller-font)', fontSize: '12.5px', lineHeight: 1.7 }}
      >
        {paragraphs.map((p, i) => {
          const asideExpand = p.kind === 'aside' && !!p.details && p.details.length > 0;
          const replyCollapse = p.kind === 'assistant' && !!p.summary;
          const collapsible = asideExpand || replyCollapse;
          const open = expanded.has(i);
          const collapsed = replyCollapse && !open;
          const text = collapsed ? p.summary! : p.text;
          const isYou = p.kind === 'you';
          line += 1;
          const n = line;
          return (
            <div key={i} className="buffer-line flex items-start px-1">
              {lineFor(n)}
              <span
                className="buffer-text flex-1"
                style={{
                  color: isYou ? 'var(--nim-text)' : 'var(--nim-text-muted)',
                  whiteSpace: 'pre-wrap',
                  fontStyle: p.kind === 'aside' ? 'italic' : undefined,
                  cursor: collapsible ? 'pointer' : undefined,
                }}
                onClick={collapsible ? () => toggleExpanded(i) : undefined}
                data-testid={collapsible ? 'buffer-expand' : undefined}
                title={collapsible ? (open ? 'Collapse' : 'Expand') : undefined}
              >
                {isYou ? (
                  <>
                    <span style={{ color: 'var(--nim-success)', marginRight: 6 }}>+</span>
                    {text}
                  </>
                ) : (
                  <span style={{ color: 'var(--nim-success)' }}>{`// `}
                    <span style={{ color: 'var(--nim-text-muted)', fontStyle: p.kind === 'aside' ? 'italic' : undefined }}>{text}</span>
                  </span>
                )}
                {collapsed && !text.endsWith('…') && (
                  <span style={{ color: 'var(--nim-text-muted)', opacity: 0.7 }}> …</span>
                )}
                {asideExpand && open && (
                  <span className="buffer-tool-detail block" style={{ fontStyle: 'normal' }}>
                    {p.details!.map((d, di) => (
                      <span key={di} className="block" style={{ color: 'var(--nim-text-muted)', whiteSpace: 'pre-wrap' }}>
                        {`    `}{d}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </div>
          );
        })}

        {/* Suggested follow-ups ride as clickable comment lines. */}
        {choices.map((c, i) => {
          line += 1;
          const n = line;
          return (
            <div key={`choice-${i}`} className="buffer-suggestion flex items-start px-1">
              {lineFor(n)}
              <button
                className="buffer-suggestion-btn flex-1 text-left"
                style={{ color: 'var(--nim-text-muted)', opacity: 0.85 }}
                onClick={() => onChoice(c.prompt)}
                disabled={sending}
                title={c.prompt}
              >
                <span style={{ color: 'var(--nim-primary)' }}>{`// → `}</span>
                {c.label}
              </button>
            </div>
          );
        })}

        {/* Composer — the live last line. */}
        <div className="buffer-composer-line flex items-start px-1">
          {lineFor(line + 1)}
          <span style={{ color: 'var(--nim-success)', marginRight: 6, paddingTop: 1 }}>+</span>
          <textarea
            ref={composerRef}
            className="buffer-composer-input flex-1 resize-none bg-transparent outline-none"
            style={{ color: 'var(--nim-text)', caretColor: 'var(--nim-primary)', fontFamily: 'inherit', fontSize: '12.5px', lineHeight: 1.7, maxHeight: 200 }}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="buffer-composer-input"
          />
        </div>
      </div>

      {/* Status bar — controls tucked away, editor-style. */}
      <div
        className="buffer-statusbar flex items-center shrink-0"
        style={{
          borderTop: '1px solid var(--nim-border)',
          background: 'var(--nim-bg-tertiary)',
          fontFamily: 'var(--nim-controller-font)',
          fontSize: '10.5px',
          color: 'var(--nim-text-muted)',
        }}
      >
        <button
          className="buffer-reply-style px-2.5 py-1"
          style={{ borderRight: '1px solid var(--nim-border)', color: replyStyle === 'default' ? 'var(--nim-text-muted)' : 'var(--nim-primary)' }}
          onClick={onCycleReplyStyle}
          data-testid="buffer-reply-style"
          title="How terse the agent answers"
        >
          {REPLY_STYLE_LABELS[replyStyle]}
        </button>
        <button
          className="buffer-speech-mode px-2.5 py-1"
          style={{ borderRight: '1px solid var(--nim-border)', color: speechMode === 'off' ? 'var(--nim-text-muted)' : 'var(--nim-primary)' }}
          onClick={onCycleSpeech}
          data-testid="buffer-speech-mode"
          title="Read replies aloud"
        >
          {SPEECH_MODE_LABELS[speechMode]}
        </button>
        <button
          className="buffer-compact px-2.5 py-1"
          style={{ borderRight: '1px solid var(--nim-border)', color: draft.trim() && !compacting ? 'var(--nim-text-muted)' : 'var(--nim-border)' }}
          onClick={onCompact}
          disabled={compacting || sending || !draft.trim()}
          data-testid="buffer-compact"
          title="Rewrite the draft into terse shorthand — does not send"
        >
          {compacting ? '…' : '⤳'}
        </button>
        <span className="flex-1" />
        <span className="px-2.5 py-1" style={{ borderLeft: '1px solid var(--nim-border)' }}>Ln {line + 1}, Col {draft.length + 1}</span>
        <button
          className="buffer-send px-2.5 py-1"
          style={{ borderLeft: '1px solid var(--nim-border)', color: canSend ? 'var(--nim-primary)' : 'var(--nim-text-muted)' }}
          onClick={onSend}
          disabled={!canSend}
          data-testid="buffer-send"
          title="Send (Shift+Enter)"
        >
          ⏎
        </button>
      </div>
    </div>
  );
}
