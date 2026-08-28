// @vitest-environment node
/**
 * The controller has no terminal emulator, so this module is the whole of its
 * interpretation of PTY output. Getting it wrong doesn't throw — it just fills
 * the pane with escape-code soup or thousands of progress-bar lines.
 */
import { describe, expect, it } from 'vitest';
import { appendTerminalOutput, stripAnsi, MAX_TERMINAL_CHARS } from '../controllerTerminal';

describe('stripAnsi', () => {
  it('drops colour and cursor sequences but keeps the text', () => {
    expect(stripAnsi('\u001B[32mok\u001B[0m done')).toBe('ok done');
    expect(stripAnsi('\u001B[2J\u001B[Hcleared')).toBe('cleared');
  });

  it('drops an OSC title sequence, terminated either way', () => {
    expect(stripAnsi('\u001B]0;my title\u0007prompt$ ')).toBe('prompt$ ');
    expect(stripAnsi('\u001B]7;file:///tmp\u001B\\x')).toBe('x');
  });

  it('keeps newlines and tabs', () => {
    expect(stripAnsi('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('appendTerminalOutput', () => {
  it('rewrites the current line on a carriage return', () => {
    // A progress bar emits `\r` per frame; appending would stack every frame.
    const out = appendTerminalOutput('', 'done: 10%\rdone: 50%\rdone: 100%');
    expect(out).toBe('done: 100%');
  });

  it('keeps completed lines when a later line is rewritten', () => {
    expect(appendTerminalOutput('', 'first\nsecond\rthird')).toBe('first\nthird');
  });

  it('treats a CR (or run of CRs) before a newline as a line end, not a rewrite', () => {
    // A CRLF is an ordinary line end; erasing on the CR would blank the line.
    expect(appendTerminalOutput('', 'echo hi\r\n')).toBe('echo hi\n');
    // Interactive zsh ends a prompt paint with a run of bare CRs then LF.
    expect(appendTerminalOutput('', 'w@m04 % \r\r\ndone')).toBe('w@m04 % \ndone');
    // A lone mid-line CR (a real progress bar) must still rewrite.
    expect(appendTerminalOutput('', 'aaa\rbbb')).toBe('bbb');
  });

  it('applies a backspace as a delete, but not past the line start', () => {
    expect(appendTerminalOutput('', 'abc\b')).toBe('ab');
    expect(appendTerminalOutput('', 'a\n\b\b')).toBe('a\n');
  });

  it('caps the retained buffer', () => {
    const out = appendTerminalOutput('x'.repeat(MAX_TERMINAL_CHARS), 'y'.repeat(500));
    expect(out).toHaveLength(MAX_TERMINAL_CHARS);
    expect(out.endsWith('y'.repeat(500))).toBe(true);
  });
});
