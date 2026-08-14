/**
 * Text handling for the controller's remote shell.
 *
 * The host relays raw PTY bytes, which carry the escape sequences a real
 * terminal emulator would act on. The controller has no emulator — the popover
 * renders a plain scrolling log — so the sequences are interpreted just far
 * enough to keep the log readable: colours and cursor moves are dropped,
 * carriage returns rewrite the current line (progress bars), and backspaces
 * delete a character (the shell's own echo of a correction).
 *
 * Anything fancier — a full-screen editor, htop — will look like the noise it
 * is. That is the honest trade for a 400px-wide pane over a relay.
 */

// Three alternatives, in order: an OSC string (terminated by BEL or ST, so it
// cannot share the CSI pattern), any other escape sequence, and the stray
// control bytes left over. Tab, newline, carriage return and backspace are
// deliberately NOT in the control-byte class -- the caller acts on the last two.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]|[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F]/g;

/** Drop escape sequences and stray control bytes, keeping newlines and tabs. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Hard ceiling on retained output; a `yes` typed by accident is not a crash. */
export const MAX_TERMINAL_CHARS = 60_000;

/**
 * Fold a chunk of PTY output into the visible buffer.
 *
 * Carriage return without a newline means "rewrite this line" — a progress bar
 * that appends instead would fill the pane with thousands of near-identical
 * lines. Backspace deletes, because the shell echoes corrections that way.
 */
export function appendTerminalOutput(buffer: string, chunk: string): string {
  let out = buffer;
  for (const raw of stripAnsi(chunk)) {
    if (raw === '\r') {
      const lineStart = out.lastIndexOf('\n') + 1;
      out = out.slice(0, lineStart);
    } else if (raw === '\b') {
      const lineStart = out.lastIndexOf('\n') + 1;
      if (out.length > lineStart) out = out.slice(0, -1);
    } else {
      out += raw;
    }
  }
  return out.length > MAX_TERMINAL_CHARS ? out.slice(-MAX_TERMINAL_CHARS) : out;
}
