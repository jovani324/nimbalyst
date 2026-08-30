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
    'You summarize a single reply from a coding agent for someone skimming on a phone.',
    'Write 1-3 short sentences in plain prose: what the agent did or found, and what it is asking or waiting for, if anything.',
    'No preamble ("Here is a summary"), no markdown headings, no bullet points, no code blocks.',
    'Keep it under 60 words. Output only the summary.',
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
