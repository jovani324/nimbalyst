/**
 * Pure helpers for the controller's condensed ("summary-first") transcript.
 *
 * The controller view is meant to be discreet and quick to scan: assistant
 * turns collapse to a one-line summary, runs of tool calls collapse to compact
 * chips, and the whole session exports to clean Markdown for opening in an
 * editor. These functions hold the presentation logic so it can be unit-tested
 * without React.
 */
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';

/** A scannable block: a message, or a collapsed run of consecutive tool calls. */
export type CondensedBlock =
  | { kind: 'message'; message: TranscriptViewMessage }
  | { kind: 'toolGroup'; tools: TranscriptViewMessage[] };

/**
 * Collapse a flat view-message list into scannable blocks: consecutive
 * `tool_call` messages fold into one `toolGroup`; everything else passes
 * through as a `message`. Noise the controller shouldn't have to read
 * (system messages, turn-ended markers, standalone tool_progress) is dropped.
 */
export function toCondensedBlocks(messages: TranscriptViewMessage[]): CondensedBlock[] {
  const blocks: CondensedBlock[] = [];
  let toolRun: TranscriptViewMessage[] = [];
  const flush = () => {
    if (toolRun.length > 0) {
      blocks.push({ kind: 'toolGroup', tools: toolRun });
      toolRun = [];
    }
  };
  for (const m of messages) {
    if (m.type === 'tool_call') {
      toolRun.push(m);
      continue;
    }
    flush();
    // Drop noise the controller shouldn't have to read: system/turn markers,
    // standalone progress, and empty prose turns (an assistant turn that was
    // pure tool-use, or a message whose text didn't decrypt) — those rendered as
    // "(no text)" clutter otherwise. Blocks with their own UI (tool groups,
    // interactive prompts, sub-agents) always pass through.
    if (m.type === 'system_message' || m.type === 'turn_ended' || m.type === 'tool_progress') {
      continue;
    }
    if ((m.type === 'user_message' || m.type === 'assistant_message') && !m.text?.trim()) {
      continue;
    }
    blocks.push({ kind: 'message', message: m });
  }
  flush();
  return blocks;
}

/**
 * One-line summary of assistant prose: first non-empty line with the loudest
 * Markdown syntax stripped, clamped to `max` chars. This is the "without the
 * blah blah" line the controller shows before you decide to expand.
 */
export function summarizeAssistant(text: string | undefined, max = 140): string {
  if (!text) return '';
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '';
  const stripped = firstLine
    .replace(/`{1,3}/g, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1).trimEnd()}…` : stripped;
}

/** Compact chip label for a tool call, e.g. "Edit · auth.ts" or "Bash". */
export function toolChipLabel(m: TranscriptViewMessage): string {
  const t = m.toolCall;
  if (!t) return 'tool';
  const name = t.toolDisplayName || t.toolName || 'tool';
  const target = t.targetFilePath ? t.targetFilePath.split('/').pop() : null;
  return target ? `${name} · ${target}` : name;
}

/**
 * One-line summary of a collapsed tool run, e.g. "3 edits, Bash, Read" — what
 * the group chip shows before expansion. Counts repeats of the same tool.
 */
export function summarizeToolGroup(tools: TranscriptViewMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of tools) {
    const name = m.toolCall?.toolDisplayName || m.toolCall?.toolName || 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ');
}

/**
 * Whether a tool run contains any error result — surfaced on the group chip so a
 * failure isn't hidden behind a collapsed block.
 */
export function toolGroupHasError(tools: TranscriptViewMessage[]): boolean {
  return tools.some((m) => m.toolCall?.status === 'error' || m.toolCall?.isError);
}

/**
 * Render the whole session to clean Markdown for copy / open-in-editor. User
 * and assistant prose go in full; tool calls become terse one-liners so the
 * export stays readable rather than dumping raw tool output.
 */
export function buildSessionMarkdown(
  messages: TranscriptViewMessage[],
  title: string | undefined,
): string {
  const lines: string[] = [`# ${title?.trim() || 'Session'}`, ''];
  for (const m of messages) {
    switch (m.type) {
      case 'user_message':
        if (m.text?.trim()) {
          lines.push('## You', '', m.text.trim(), '');
        }
        break;
      case 'assistant_message':
        if (m.text?.trim()) {
          lines.push('## Assistant', '', m.text.trim(), '');
        }
        break;
      case 'tool_call':
        if (m.toolCall) {
          const status = m.toolCall.status === 'error' || m.toolCall.isError ? ' [error]' : '';
          lines.push(`- \`${toolChipLabel(m)}\`${status}`);
        }
        break;
      default:
        break;
    }
  }
  // Collapse the run of blank lines a trailing tool list can leave.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Bare URLs in plain-text rows; markdown links are handled by MarkdownRenderer. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']+[^\s<>()[\]{}"'.,;:!?]/g;

/**
 * Turn bare URLs into anchors. The controller renders replies as plain text
 * (summaries, user turns), so without this a link the agent sends is something
 * you have to retype on the other machine.
 */
export function linkify(text: string): Array<string | { href: string; key: string }> {
  const out: Array<string | { href: string; key: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push({ href: match[0], key: `${start}-${match[0]}` });
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
