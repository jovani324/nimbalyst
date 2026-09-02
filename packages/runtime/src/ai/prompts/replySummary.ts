/**
 * Reply-summary prompt — turn one agent reply into a short, plain summary on the
 * HOST. Sibling of speechDigest, but with no speaking, no numbered choices and no
 * schema: the controller just wants a couple of sentences it can drop into a note
 * and answer from. The host drives a one-shot `claude -p` with this system prompt
 * and returns the text.
 */

/** One reply, not a transcript. */
export const MAX_SUMMARY_INPUT_CHARS = 12000;
/** A summary is a few sentences; cap the output so a runaway reply can't bloat a note. */
export const MAX_SUMMARY_OUTPUT_CHARS = 1200;

/** The instruction the host gives the model. Plain prose, no preamble, no markdown headings. */
export function buildReplySummarySystemPrompt(): string {
  return [
    'You condense a single reply from a coding agent so someone can skim it instead of reading the whole thing — without losing anything that matters.',
    'Capture the key points: what it did or found, any decisions or trade-offs, and what it is now asking or waiting for.',
    'Keep the concrete specifics that carry meaning — file names, commands, identifiers, numbers, the cause of an error.',
    'Use a few short lines or terse bullet points; plain text only, no headings, no code fences, no preamble like "Here is a summary".',
    'Aim for 5 lines or fewer. Output only the summary.',
  ].join(' ');
}

/** Tidy the CLI's raw stdout into the note text: strip fences, collapse blank lines, clamp. */
export function normalizeReplySummary(raw: string): string {
  const cleaned = raw
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > MAX_SUMMARY_OUTPUT_CHARS ? `${cleaned.slice(0, MAX_SUMMARY_OUTPUT_CHARS - 1)}…` : cleaned;
}
