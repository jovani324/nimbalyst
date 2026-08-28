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
import { toCondensedBlocks, summarizeToolGroup } from './condensedTranscript';

export type TextSoapPara = { kind: 'you' | 'assistant' | 'aside'; text: string };

/** Fold the projected transcript into plain document paragraphs. */
export function toParagraphs(messages: TranscriptViewMessage[]): TextSoapPara[] {
  const out: TextSoapPara[] = [];
  for (const block of toCondensedBlocks(messages)) {
    if (block.kind === 'toolGroup') {
      out.push({ kind: 'aside', text: summarizeToolGroup(block.tools) });
      continue;
    }
    const m = block.message;
    if (m.type === 'user_message') out.push({ kind: 'you', text: m.text ?? '' });
    else if (m.type === 'assistant_message') out.push({ kind: 'assistant', text: m.text ?? '' });
    else if (m.type === 'subagent') out.push({ kind: 'aside', text: 'delegated to a subagent' });
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
