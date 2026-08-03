/**
 * CondensedRemoteTranscript — the controller's "summary-first" transcript.
 *
 * Built for a discreet, quick glance rather than a full read: your prompts show
 * in full, assistant turns collapse to a one-line summary you can expand, and
 * runs of tool calls fold into a single chip. Nothing here drives the session —
 * it only renders the projected view messages the parent already holds.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { MarkdownRenderer } from '@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  toCondensedBlocks,
  summarizeAssistant,
  summarizeToolGroup,
  toolGroupHasError,
  toolChipLabel,
} from './condensedTranscript';

interface CondensedRemoteTranscriptProps {
  messages: TranscriptViewMessage[];
  isProcessing: boolean;
}

export function CondensedRemoteTranscript({ messages, isProcessing }: CondensedRemoteTranscriptProps) {
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

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="condensed-transcript flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
      data-testid="condensed-remote-transcript"
    >
      {blocks.map((block, i) => {
        if (block.kind === 'toolGroup') {
          return <ToolGroupRow key={`tg-${i}`} tools={block.tools} expandedSet={expanded} onToggle={toggle} />;
        }
        const m = block.message;
        if (m.type === 'user_message') return <UserRow key={m.id} message={m} />;
        if (m.type === 'assistant_message')
          return <AssistantRow key={m.id} message={m} expanded={expanded.has(`a-${m.id}`)} onToggle={() => toggle(`a-${m.id}`)} />;
        if (m.type === 'interactive_prompt') return <PromptChip key={m.id} />;
        if (m.type === 'subagent')
          return <SubagentRow key={m.id} message={m} expanded={expanded.has(`s-${m.id}`)} onToggle={() => toggle(`s-${m.id}`)} />;
        return null;
      })}
    </div>
  );
}

function RoleLabel({ children, color }: { children: string; color: string }) {
  return (
    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide select-none" style={{ color }}>
      {children}
    </span>
  );
}

function UserRow({ message }: { message: TranscriptViewMessage }) {
  return (
    <div
      className="condensed-user rounded px-2.5 py-2"
      style={{ background: 'var(--nim-bg-secondary)', borderLeft: '2px solid var(--nim-primary)' }}
    >
      <RoleLabel color="var(--nim-primary)">you</RoleLabel>
      <div
        className="mt-1 text-sm whitespace-pre-wrap break-words select-text leading-snug"
        style={{ color: 'var(--nim-text)' }}
      >
        {message.text?.trim()}
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
  const summary = summarizeAssistant(message.text);
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
        onClick={onToggle}
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
          <MarkdownRenderer content={message.text ?? ''} messageId={String(message.id)} />
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
  const t = tool.toolCall;
  const isError = t?.status === 'error' || t?.isError;
  return (
    <div className="text-[12px]">
      <div style={{ color: isError ? 'var(--nim-error)' : 'var(--nim-text)' }}>{toolChipLabel(tool)}</div>
      {t?.result && (
        <pre
          className="mt-0.5 max-h-40 overflow-auto rounded px-2 py-1 text-[11px] whitespace-pre-wrap break-words select-text"
          style={{ background: 'var(--nim-bg)', color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
        >
          {t.result.slice(0, 4000)}
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
