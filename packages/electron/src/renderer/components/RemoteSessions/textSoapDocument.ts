/**
 * Pure projection + text transforms behind the TextSoap controller appearance.
 *
 * Kept React-free so it can be unit-tested cheaply (node environment) and so the
 * TextSoapTranscript component stays a thin presentation shell. `toParagraphs`
 * turns the projected transcript into plain document paragraphs; the cleaners are
 * the decorative sidebar actions, which really do transform the draft so a
 * curious onlooker who clicks one sees a plausible result.
 */
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toCondensedBlocks, summarizeToolGroup, summarizeAssistant } from './condensedTranscript';

export type TextSoapPara = {
  kind: 'you' | 'assistant' | 'aside';
  text: string;
  /** For 'aside' (a folded tool run): the per-tool command lines, shown on expand. */
  details?: string[];
  /** For a long assistant reply: a one-line skim shown until the line is expanded. */
  summary?: string;
};

/** One human-readable line per tool call — the command or the target it touched. */
function toolDetail(m: TranscriptViewMessage): string {
  const tc = m.toolCall;
  if (!tc) return '';
  const args = tc.arguments as Record<string, unknown> | undefined;
  const cmd = typeof args?.command === 'string' ? args.command.trim() : undefined;
  if (cmd) return `$ ${cmd}`;
  const name = tc.toolDisplayName || tc.toolName || 'tool';
  if (tc.targetFilePath) return `${name} ${tc.targetFilePath}`;
  const pattern = typeof args?.pattern === 'string' ? args.pattern : undefined;
  return pattern ? `${name} ${pattern}` : name;
}

/** Fold the projected transcript into plain document paragraphs. */
export function toParagraphs(messages: TranscriptViewMessage[]): TextSoapPara[] {
  const out: TextSoapPara[] = [];
  for (const block of toCondensedBlocks(messages)) {
    if (block.kind === 'toolGroup') {
      out.push({
        kind: 'aside',
        text: summarizeToolGroup(block.tools),
        details: block.tools.map(toolDetail).filter((d) => d.length > 0),
      });
      continue;
    }
    const m = block.message;
    if (m.type === 'user_message') out.push({ kind: 'you', text: m.text ?? '' });
    else if (m.type === 'assistant_message') {
      // Long replies fold to a one-line skim (like the other themes' condensed
      // view); short ones show whole. summarizeAssistant strips markdown + clamps.
      const text = m.text ?? '';
      const long = text.includes('\n') || text.length > 180;
      out.push(long ? { kind: 'assistant', text, summary: summarizeAssistant(text, 160) } : { kind: 'assistant', text });
    } else if (m.type === 'subagent') out.push({ kind: 'aside', text: 'delegated to a subagent' });
    // interactive_prompt is answered by the parent's widget, not shown as prose.
  }
  return out.filter((p) => p.text.trim().length > 0);
}

/** Decorative cleaners that actually transform the draft, for plausibility. */
export const TEXT_CLEANERS: Array<{ label: string; run: (s: string) => string }> = [
  { label: 'Remove Extra Spaces', run: (s) => s.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n') },
  { label: 'Straighten Quotes', run: (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"') },
  { label: 'Make Paragraphs', run: (s) => s.replace(/\n{3,}/g, '\n\n').trim() },
  { label: 'Capitalize Sentences', run: (s) => s.replace(/(^|[.!?]\s+)([a-z])/g, (_, p, c) => p + c.toUpperCase()) },
];
