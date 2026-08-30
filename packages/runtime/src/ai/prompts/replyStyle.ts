/**
 * Reply style: how terse the agent should answer a controller-sent prompt.
 *
 * A controller never launches sessions -- it only drives ones the host already
 * started -- so it cannot reach the CLI's `--append-system-prompt`. The only
 * lever it has on a running session is the prompt itself, so the style travels
 * as a directive line appended to each outgoing prompt.
 *
 * Lives here because there are three controllers (the Electron popover, the
 * standalone web app, and the separate-repo Mac app) and the directive wording
 * is the product, not an implementation detail -- a second copy drifts. Pure
 * and dependency-free so every one of them can import it, and so persistence
 * stays with the caller: app-settings in Electron, localStorage on the web.
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

/**
 * Marker for the choice directive. Same idempotency rule as the style marker.
 * Separate so a controller can ask for choices at any terseness.
 */
const CHOICES_MARKER = '[reply-choices]';

const CHOICES_DIRECTIVE =
  `${CHOICES_MARKER} If you need a decision from me, end with at most three numbered ` +
  'options, one short line each, the likeliest first. If you need nothing, end with ' +
  'one line saying so. Style only -- the message above is the request.';

/**
 * Ask the reply to end with numbered options when a decision is needed, so the
 * spoken digest transcribes real choices instead of inventing them. Appended
 * after the style directive when both apply; never twice.
 */
export function applyChoiceDirective(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(CHOICES_MARKER)) return trimmed;
  return `${trimmed}\n\n${CHOICES_DIRECTIVE}`;
}

/**
 * Remove trailing directive plumbing for display. Both the style and the choice
 * directive are appended by the composer, not typed by the sender, so the
 * transcript hides them. Strips from whichever marker comes first (the choice
 * directive can ride alone, without a style directive above it) to the end.
 *
 * One thing after the directive IS the sender's: when a prompt carries images,
 * the host tacks `@filename` references onto the same line as the directive
 * (see MobileSessionControlHandler). Those are what a reader clicks to open the
 * picture, so a trailing run of them survives the strip.
 */
export function stripReplyStyle(text: string): string {
  const marks = [text.indexOf(MARKER), text.indexOf(CHOICES_MARKER)].filter((i) => i >= 0);
  if (marks.length === 0) return text;
  const at = Math.min(...marks);
  const before = text.slice(0, at).replace(/\s+$/, '');
  // Attachment refs the host appended after the directive, e.g. " @shot.png".
  const refs = text.slice(at).match(/(?:\s@\S+)+\s*$/);
  const tail = refs ? refs[0].trim() : '';
  if (!tail) return before;
  return before ? `${before} ${tail}` : tail;
}
