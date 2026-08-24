/**
 * CondensedRemoteTranscript — the controller's "summary-first" transcript.
 *
 * Built for a discreet, quick glance rather than a full read: your prompts show
 * in full, assistant turns collapse to a one-line summary you can expand, and
 * runs of tool calls fold into a single chip. Nothing here drives the session —
 * it only renders the projected view messages the parent already holds.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { MarkdownRenderer } from '@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  linkify,
  parseFileRef,
  toCondensedBlocks,
  summarizeAssistant,
  summarizeToolGroup,
  toolGroupHasError,
  toolChipLabel,
} from './condensedTranscript';
import { redactSecrets } from './controllerPrivacy';

/** Opens a file the host holds; null when nobody upstream can show one. */
const FileOpenContext = createContext<((path: string, line?: number) => void) | null>(null);
const useOpenFile = () => useContext(FileOpenContext);

/** Plain text with its URLs as anchors and its file references as buttons. */
function LinkedText({ text }: { text: string }) {
  const openFile = useOpenFile();
  return (
    <>
      {linkify(text).map((part, i) => {
        if (typeof part === 'string') return part;
        if (part.kind === 'url') {
          return (
            <a key={`${part.key}-${i}`} href={part.href} style={{ color: 'var(--nim-primary)' }}>
              {part.href}
            </a>
          );
        }
        if (!openFile) return part.text;
        return (
          <button
            key={`${part.key}-${i}`}
            className="remote-file-ref"
            style={{ color: 'var(--nim-primary)' }}
            onClick={() => openFile(part.path, part.line)}
            title={`Open ${part.path} from the host`}
          >
            {part.text}
          </button>
        );
      })}
    </>
  );
}

/**
 * Handle clicks inside the transcript: links go to the OS browser, and a file
 * path in rendered Markdown (which arrives as inline `code`, not through
 * LinkedText) opens in the remote viewer.
 *
 * A plain anchor click navigates the popover itself away from the app — the
 * window has no chrome to get back with, so the controller would simply become
 * a web page until it is restarted.
 */
function useTranscriptClick(openFile: ((path: string, line?: number) => void) | null) {
  return (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    const href = anchor?.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      void window.electronAPI?.openExternal?.(href);
      return;
    }
    const code = target?.closest?.('code') as HTMLElement | null;
    if (!code || !openFile) return;
    const ref = parseFileRef(code.textContent ?? '');
    if (!ref) return;
    e.preventDefault();
    e.stopPropagation();
    openFile(ref.path, ref.line);
  };
}

/** Provides the active text transform (identity, or secret-redaction) to rows. */
const RedactContext = createContext<(s: string) => string>((s) => s);
const useRedact = () => useContext(RedactContext);

interface CondensedRemoteTranscriptProps {
  messages: TranscriptViewMessage[];
  isProcessing: boolean;
  /** Mask secret-looking strings in rendered text. */
  redact?: boolean;
  /** Blur each message until hovered (hover-to-reveal privacy mode). */
  perMessageBlur?: boolean;
  /** Show a file the host holds; omitted when no viewer is mounted. */
  onOpenFile?: (path: string, line?: number) => void;
}

export function CondensedRemoteTranscript({
  messages,
  isProcessing,
  redact,
  perMessageBlur,
  onOpenFile,
}: CondensedRemoteTranscriptProps) {
  const handleClick = useTranscriptClick(onOpenFile ?? null);
  const blocks = useMemo(() => toCondensedBlocks(messages), [messages]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Stick to the bottom as new messages arrive, but only when the user is
  // already near the bottom so expanding an old turn doesn't yank them down.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, expanded]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (blocks.length === 0) {
    return (
      <div
        className="condensed-transcript-empty flex flex-1 items-center justify-center text-sm"
        style={{ color: 'var(--nim-text-muted)' }}
      >
        {isProcessing ? 'Working…' : 'No messages yet.'}
      </div>
    );
  }

  const blockClass = perMessageBlur ? 'condensed-pm-blur' : undefined;
  return (
    <RedactContext.Provider value={redact ? redactSecrets : (s) => s}>
      <FileOpenContext.Provider value={onOpenFile ?? null}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={handleClick}
        className="condensed-transcript flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2 select-text"
        data-testid="condensed-remote-transcript"
      >
        {blocks.map((block, i) => {
          let node;
          if (block.kind === 'toolGroup') {
            node = <ToolGroupRow tools={block.tools} expandedSet={expanded} onToggle={toggle} />;
          } else {
            const m = block.message;
            if (m.type === 'user_message') node = <UserRow message={m} />;
            else if (m.type === 'assistant_message')
              node = <AssistantRow message={m} expanded={expanded.has(`a-${m.id}`)} onToggle={() => toggle(`a-${m.id}`)} />;
            else if (m.type === 'interactive_prompt') node = <PromptChip />;
            else if (m.type === 'subagent')
              node = <SubagentRow message={m} expanded={expanded.has(`s-${m.id}`)} onToggle={() => toggle(`s-${m.id}`)} />;
            else node = null;
          }
          if (!node) return null;
          const key = block.kind === 'toolGroup' ? `tg-${block.tools[0]?.id ?? i}` : block.message.id;
          return (
            <div key={key} className={blockClass}>
              {node}
            </div>
          );
        })}
      </div>
      </FileOpenContext.Provider>
    </RedactContext.Provider>
  );
}

function UserRow({ message }: { message: TranscriptViewMessage }) {
  const redact = useRedact();
  return (
    <div
      className="condensed-user rounded px-2.5 py-2"
      style={{ background: 'var(--nim-bg-secondary)', borderLeft: '2px solid var(--nim-primary)' }}
    >
      <div
        className="text-sm whitespace-pre-wrap break-words select-text leading-snug"
        style={{ color: 'var(--nim-text)' }}
      >
        <LinkedText text={redact(message.text?.trim() ?? '')} />
      </div>
    </div>
  );
}

function AssistantRow({
  message,
  expanded,
  onToggle,
}: {
  message: TranscriptViewMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const redact = useRedact();
  const summary = redact(summarizeAssistant(message.text));
  const [copied, setCopied] = useState(false);
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    if (message.text) {
      void navigator.clipboard.writeText(message.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      });
    }
  };
  return (
    <div className="condensed-assistant rounded px-1 py-0.5">
      <div
        className="flex gap-2 items-baseline cursor-pointer group"
        // Selecting text inside the row ends in a click; without this, dragging
        // across a summary to copy it collapses the message you were reading.
        onClick={() => {
          if (window.getSelection()?.toString()) return;
          onToggle();
        }}
        data-testid="condensed-assistant-row"
      >
        <span className="shrink-0 text-[11px] select-none" style={{ color: 'var(--nim-text-muted)', width: 10 }}>
          {expanded ? '▾' : '▸'}
        </span>
        {!expanded && (
          <span className="min-w-0 flex-1 truncate text-sm leading-snug" style={{ color: 'var(--nim-text)' }}>
            {summary}
          </span>
        )}
        <button
          className="condensed-copy shrink-0 text-[11px] opacity-0 group-hover:opacity-100 px-1 rounded"
          style={{ color: 'var(--nim-text-muted)' }}
          onClick={copy}
          title="Copy message"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {expanded && (
        <div className="pl-5 pt-1 text-sm select-text leading-relaxed" style={{ color: 'var(--nim-text)' }}>
          <MarkdownRenderer content={redact(message.text ?? '')} messageId={String(message.id)} />
        </div>
      )}
    </div>
  );
}

function ToolGroupRow({
  tools,
  expandedSet,
  onToggle,
}: {
  tools: TranscriptViewMessage[];
  expandedSet: Set<string>;
  onToggle: (key: string) => void;
}) {
  const groupKey = `tg-${tools[0]?.id}`;
  const open = expandedSet.has(groupKey);
  const hasError = toolGroupHasError(tools);
  return (
    <div className="condensed-tools pl-5">
      <button
        className="flex gap-1.5 items-center text-[12px] px-1.5 py-0.5 rounded"
        style={{
          color: hasError ? 'var(--nim-error)' : 'var(--nim-text-muted)',
          background: 'var(--nim-bg-secondary)',
        }}
        onClick={() => onToggle(groupKey)}
        data-testid="condensed-tool-group"
      >
        <span className="select-none">{open ? '▾' : '▸'}</span>
        <span className="select-none">⛏</span>
        <span className="truncate">{summarizeToolGroup(tools)}</span>
      </button>
      {open && (
        <div className="pl-4 pt-1 space-y-1">
          {tools.map((t) => (
            <ToolDetail key={t.id} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetail({ tool }: { tool: TranscriptViewMessage }) {
  const redact = useRedact();
  const t = tool.toolCall;
  const isError = t?.status === 'error' || t?.isError;
  return (
    <div className="condensed-remote-tool-detail text-[12px]">
      <div style={{ color: isError ? 'var(--nim-error)' : 'var(--nim-text)' }}>{redact(toolChipLabel(tool))}</div>
      {t?.result && (
        <pre
          className="mt-0.5 max-h-40 overflow-auto rounded px-2 py-1 text-[11px] whitespace-pre-wrap break-words select-text"
          style={{ background: 'var(--nim-bg)', color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
        >
          {redact(t.result.slice(0, 4000))}
        </pre>
      )}
    </div>
  );
}

function PromptChip() {
  // A marker for where an interactive prompt sits in the flow. The actionable
  // widget (answer buttons) is rendered by the parent below the transcript when
  // a prompt is still pending, so this stays a neutral, non-claiming marker.
  return (
    <div className="pl-5 text-[12px]" style={{ color: 'var(--nim-text-muted)' }} data-testid="condensed-prompt-chip">
      ❓ interactive prompt
    </div>
  );
}

function SubagentRow({
  message,
  expanded,
  onToggle,
}: {
  message: TranscriptViewMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const children = message.subagent?.childEvents ?? [];
  return (
    <div className="condensed-subagent pl-5">
      <button
        className="flex gap-1.5 items-center text-[12px] px-1.5 py-0.5 rounded"
        style={{ color: 'var(--nim-text-muted)', background: 'var(--nim-bg-secondary)' }}
        onClick={onToggle}
      >
        <span className="select-none">{expanded ? '▾' : '▸'}</span>
        <span className="select-none">◇</span>
        <span className="truncate">sub-agent · {children.length} steps</span>
      </button>
      {expanded && (
        <div className="pl-4 pt-1">
          <CondensedRemoteTranscript messages={children} isProcessing={false} />
        </div>
      )}
    </div>
  );
}
