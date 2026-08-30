/**
 * Slash-command parsing for the notes body, shared by every controller surface.
 *
 * Antinote-vibe: you type a command on its own line and it fires. This parser
 * only recognizes a command as the *last non-empty line* of the body -- so a
 * `/send` you wrote earlier in the note is prose, not a trigger. Pure: it
 * decides nothing, it only classifies. The panel wiring acts on the result.
 */
import { ACCENTS, type Accent } from './model';

export type SlashCommand =
  | { command: 'send' }
  | { command: 'new' }
  | { command: 'clear' }
  | { command: 'accent'; accent: Accent };

/** Return the command on the body's last non-empty line, or `null`. */
export function parseSlash(body: string): SlashCommand | null {
  const lines = body.split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      last = lines[i].trim();
      break;
    }
  }
  if (!last.startsWith('/')) return null;

  const [word, ...rest] = last.slice(1).split(/\s+/);
  switch (word.toLowerCase()) {
    case 'send':
      return { command: 'send' };
    case 'new':
      return { command: 'new' };
    case 'clear':
      return { command: 'clear' };
    case 'accent': {
      const accent = rest[0]?.toLowerCase();
      return ACCENTS.includes(accent as Accent) ? { command: 'accent', accent: accent as Accent } : null;
    }
    default:
      return null;
  }
}

/** Strip a trailing command line so it never lands in the sent/kept text. */
export function stripTrailingCommand(body: string): string {
  const lines = body.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim().length === 0) i--;
  if (i >= 0 && lines[i].trim().startsWith('/')) {
    return lines.slice(0, i).join('\n').replace(/\s+$/, '');
  }
  return body;
}
