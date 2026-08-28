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
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
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
  setDraft: (value: string) => void;
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

  // Keep the composed line in view as turns arrive, like a document scrolled to
  // the caret. Runs on new turns and when the agent starts/stops.
  useEffect(() => {
    const el = docRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [paragraphs.length, isExecuting]);

  const composerLine = paragraphs.length + 1;
  const inkFor = (kind: TextSoapPara['kind']) =>
    kind === 'you' ? 'var(--nim-text)' : kind === 'assistant' ? 'var(--nim-text-muted)' : 'var(--nim-text-muted)';

  return (
    <div className="textsoap-transcript flex-1 min-h-0 flex" data-testid="textsoap-transcript">
      {/* Document */}
      <div
        ref={docRef}
        className="textsoap-document flex-1 min-h-0 overflow-y-auto py-2 select-text"
        style={{ background: 'var(--nim-bg)', fontFamily: 'var(--nim-controller-font)' }}
      >
        {paragraphs.map((p, i) => (
          <div key={i} className="textsoap-para flex items-start px-1 leading-relaxed">
            <span
              className="textsoap-linenum shrink-0 text-right pr-3 select-none text-[11px] pt-[2px]"
              style={{ width: 40, color: 'var(--nim-text-muted)', opacity: 0.55 }}
            >
              {i + 1}
            </span>
            <span
              className="textsoap-paratext flex-1 text-[12.5px]"
              style={{ color: inkFor(p.kind), whiteSpace: 'pre-wrap', fontStyle: p.kind === 'aside' ? 'italic' : undefined }}
            >
              {p.kind === 'aside' ? `// ${p.text}` : p.text}
              <span className="textsoap-pilcrow" style={{ color: 'var(--nim-primary)', opacity: 0.5, marginLeft: 2 }}>
                ¶
              </span>
            </span>
          </div>
        ))}

        {/* Composer — the live last paragraph */}
        <div className="textsoap-composer-para flex items-start px-1">
          <span
            className="textsoap-linenum shrink-0 text-right pr-3 select-none text-[11px] pt-[2px]"
            style={{ width: 40, color: 'var(--nim-primary)' }}
          >
            {composerLine}
          </span>
          <textarea
            className="textsoap-composer-input flex-1 resize-none bg-transparent outline-none text-[12.5px] leading-relaxed"
            style={{ color: 'var(--nim-text)', caretColor: 'var(--nim-primary)', maxHeight: 200, fontFamily: 'inherit' }}
            rows={1}
            placeholder="Type here…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="textsoap-composer-input"
          />
        </div>
      </div>

      {/* Cleaner sidebar */}
      <div
        className="textsoap-cleaners shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 208, background: 'var(--nim-bg-secondary)', borderLeft: '1px solid var(--nim-border)' }}
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
