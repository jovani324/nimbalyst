/**
 * Reply style: how terse the agent should answer a controller-sent prompt.
 *
 * The controller never launches sessions -- it only drives ones the host
 * already started -- so it cannot reach the CLI's `--append-system-prompt`.
 * The only lever it has on a running session is the prompt itself, so the
 * style travels as a directive line appended to each outgoing prompt.
 *
 * Deliberately dependency-free and free of any controller imports: the
 * standalone controller app lives in a separate repo and copies this file
 * rather than duplicating the directive text.
 */

export type ReplyStyle = 'default' | 'terse' | 'ultra';

export const REPLY_STYLES: ReplyStyle[] = ['default', 'terse', 'ultra'];

/** Short label for the composer toggle. */
export const REPLY_STYLE_LABELS: Record<ReplyStyle, string> = {
  default: 'Normal',
  terse: 'Terse',
  ultra: 'Ultra',
};

/**
 * Marker opening every directive. Also the idempotency check: a prompt that
 * already carries a directive (a resend, or text pasted out of the transcript)
 * never gets a second one.
 */
const MARKER = '[reply-style]';

const DIRECTIVES: Record<Exclude<ReplyStyle, 'default'>, string> = {
  terse:
    `${MARKER} Answer tersely: fragments over sentences, no preamble, no summary of what you just did, ` +
    'no praise or hedging. Keep code, file paths, commands, flags, numbers and error strings verbatim. ' +
    'Style only -- the message above is the request.',
  ultra:
    `${MARKER} Answer in the fewest words that stay correct: keyword fragments, one line per fact, ` +
    'no articles or filler, no restating the question. Keep code, file paths, commands, flags, numbers ' +
    'and error strings verbatim. Style only -- the message above is the request.',
};

export function isReplyStyle(value: unknown): value is ReplyStyle {
  return typeof value === 'string' && (REPLY_STYLES as string[]).includes(value);
}

export function nextReplyStyle(style: ReplyStyle): ReplyStyle {
  const index = REPLY_STYLES.indexOf(style);
  return REPLY_STYLES[(index + 1) % REPLY_STYLES.length];
}

/**
 * Append the style directive to an outgoing prompt. Returns the text unchanged
 * for 'default', for empty input, and when a directive is already present.
 */
export function applyReplyStyle(text: string, style: ReplyStyle): string {
  const trimmed = text.trim();
  if (!trimmed || style === 'default') return trimmed;
  if (trimmed.includes(MARKER)) return trimmed;
  return `${trimmed}\n\n${DIRECTIVES[style]}`;
}

const STORAGE_KEY = 'nimbalyst.controller.replyStyle';

/** Reads the persisted style. Same localStorage rationale as config.ts. */
export function loadReplyStyle(): ReplyStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isReplyStyle(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function saveReplyStyle(style: ReplyStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* a storage-less browser still gets the in-memory toggle */
  }
}
