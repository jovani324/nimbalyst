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
 * Extensions that make a token a file reference. A whitelist rather than "any
 * extension" on purpose: `example.com` and `v1.2` are not files, and a bare
 * domain turned into a dead file link is worse than plain text.
 */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'css', 'scss', 'less', 'html', 'vue', 'svelte', 'svg',
  'md', 'mdx', 'txt', 'rst',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'pl',
  'sh', 'bash', 'zsh', 'fish',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'xml', 'plist',
  'sql', 'prisma', 'graphql', 'gql', 'proto', 'gradle', 'podspec',
]);

/**
 * Extensions that are pictures, not source. Kept apart from FILE_EXTENSIONS
 * because they open differently: a picture cannot render in the source viewer,
 * so it goes to the host's OS default app instead.
 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'avif', 'tiff', 'tif', 'ico',
]);

/** A clickable piece of a plain-text row. */
export type LinkPart =
  | { kind: 'url'; href: string; key: string }
  | { kind: 'file'; path: string; line?: number; isImage?: true; text: string; key: string };

/**
 * Read a file reference out of a standalone token (`src/a.ts:42`), or null if it
 * isn't one. Shared with the transcript's click delegation so an inline-code
 * path in rendered Markdown opens the same way a plain-text one does.
 */
export function parseFileRef(token: string): { path: string; line?: number; isImage?: true } | null {
  // An attachment mention (`@shot.png`) wears an @ the file on disk does not;
  // strip it from the path but leave the shown token alone.
  const trimmed = token.trim().replace(/^@/, '');
  const match = /^((?:[\w.@~-]+\/)*[\w.@-]+\.([A-Za-z][A-Za-z0-9]{0,7}))(?::(\d+))?(?::\d+)?$/.exec(trimmed);
  if (!match) return null;
  const ext = match[2].toLowerCase();
  if (!FILE_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) return null;
  // `isImage: true`-or-absent (never false) so existing toEqual assertions on
  // source-file parts stay exact.
  return {
    path: match[1],
    line: match[3] ? Number(match[3]) : undefined,
    ...(IMAGE_EXTENSIONS.has(ext) ? { isImage: true as const } : {}),
  };
}

/**
 * Split a stretch of text with no URLs in it into plain text and file refs.
 *
 * Deliberately token-at-a-time against an anchored matcher: an unanchored
 * path pattern scanning a pasted log with no references in it backtracks
 * quadratically, and pasted logs are exactly what lands in these rows.
 */
function linkifyFileRefs(text: string, offset: number): Array<string | LinkPart> {
  const out: Array<string | LinkPart> = [];
  let last = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index ?? 0;
    // Brackets and sentence punctuation belong to the prose, not to the path.
    const withoutLead = match[0].replace(/^[('"`[<]+/, '');
    const token = withoutLead.replace(/[)'"`\]>,.;:!?]+$/, '');
    const ref = parseFileRef(token);
    if (!ref) continue;
    const from = start + (match[0].length - withoutLead.length);
    if (from > last) out.push(text.slice(last, from));
    out.push({
      kind: 'file',
      path: ref.path,
      line: ref.line,
      ...(ref.isImage ? { isImage: true as const } : {}),
      text: token,
      key: `f${offset + from}-${token}`,
    });
    last = from + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Turn bare URLs and file references into clickable parts. The controller
 * renders replies as plain text (summaries, user turns), so without this a link
 * the agent sends is something you have to retype on the other machine, and a
 * file it names is something you cannot look at at all — the checkout only
 * exists on the host.
 */
export function linkify(text: string): Array<string | LinkPart> {
  const out: Array<string | LinkPart> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) out.push(...linkifyFileRefs(text.slice(last, start), last));
    out.push({ kind: 'url', href: match[0], key: `u${start}-${match[0]}` });
    last = start + match[0].length;
  }
  if (last < text.length) out.push(...linkifyFileRefs(text.slice(last), last));
  return out;
}
