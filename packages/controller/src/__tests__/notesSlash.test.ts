// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseSlash, stripTrailingCommand, takeReplyAfterSeparator } from '@nimbalyst/runtime/notes/slash';

describe('takeReplyAfterSeparator', () => {
  it('sends only what is below the last --- rule', () => {
    expect(takeReplyAfterSeparator('summary line\n---\nmy actual reply')).toBe('my actual reply');
  });

  it('uses the last rule when there are several', () => {
    expect(takeReplyAfterSeparator('a\n---\nb\n---\nc')).toBe('c');
  });

  it('sends the whole body when there is no separator', () => {
    expect(takeReplyAfterSeparator('just a note')).toBe('just a note');
  });
});

describe('parseSlash', () => {
  it('recognizes bare commands on the last line', () => {
    expect(parseSlash('note text\n/send')).toEqual({ command: 'send' });
    expect(parseSlash('/new')).toEqual({ command: 'new' });
    expect(parseSlash('stuff\n/clear\n\n')).toEqual({ command: 'clear' });
  });

  it('parses /accent with a valid color only', () => {
    expect(parseSlash('/accent pink')).toEqual({ command: 'accent', accent: 'pink' });
    expect(parseSlash('/accent PINK')).toEqual({ command: 'accent', accent: 'pink' });
    expect(parseSlash('/accent mauve')).toBeNull();
    expect(parseSlash('/accent')).toBeNull();
  });

  it('ignores a command that is not on the last non-empty line', () => {
    expect(parseSlash('/send\nmore text')).toBeNull();
  });

  it('returns null for plain text and unknown commands', () => {
    expect(parseSlash('just a note')).toBeNull();
    expect(parseSlash('/frobnicate')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });
});

describe('stripTrailingCommand', () => {
  it('removes only a trailing command line', () => {
    expect(stripTrailingCommand('keep this\n/send')).toBe('keep this');
    expect(stripTrailingCommand('keep this\n/send\n\n')).toBe('keep this');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripTrailingCommand('keep this\nand this')).toBe('keep this\nand this');
    expect(stripTrailingCommand('/send\ntrailing prose')).toBe('/send\ntrailing prose');
  });
});
