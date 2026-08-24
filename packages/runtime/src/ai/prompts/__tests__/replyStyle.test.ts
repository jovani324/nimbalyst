// @vitest-environment node
/**
 * The controller cannot reach the CLI's --append-system-prompt (it never
 * launches sessions), so terseness rides along on each outgoing prompt. What a
 * reader cannot see: the directive must never be appended twice, or a resend of
 * transcript text stacks them.
 */
import { describe, expect, it } from 'vitest';
import {
  applyChoiceDirective,
  applyReplyStyle,
  nextReplyStyle,
  REPLY_STYLES,
  stripReplyStyle,
} from '../replyStyle';

describe('applyReplyStyle', () => {
  it('leaves the prompt alone on the default style', () => {
    expect(applyReplyStyle('fix the parser', 'default')).toBe('fix the parser');
  });

  it('appends a directive after the request for terse and ultra', () => {
    for (const style of ['terse', 'ultra'] as const) {
      const out = applyReplyStyle('fix the parser', style);
      expect(out.startsWith('fix the parser')).toBe(true);
      expect(out).toContain('[reply-style]');
    }
  });

  it('never stacks a second directive on already-styled text', () => {
    const once = applyReplyStyle('fix the parser', 'terse');
    expect(applyReplyStyle(once, 'ultra')).toBe(once);
    expect(once.match(/\[reply-style\]/g)).toHaveLength(1);
  });

  it('sends nothing for whitespace-only input', () => {
    expect(applyReplyStyle('   \n ', 'terse')).toBe('');
  });

  it('cycles through every style and wraps', () => {
    let style = REPLY_STYLES[0];
    const seen = [style];
    for (let i = 0; i < REPLY_STYLES.length; i++) {
      style = nextReplyStyle(style);
      seen.push(style);
    }
    expect(new Set(seen).size).toBe(REPLY_STYLES.length);
    expect(seen[seen.length - 1]).toBe(REPLY_STYLES[0]);
  });
});

describe('applyChoiceDirective', () => {
  it('stacks once after the style directive and never twice', () => {
    const styled = applyReplyStyle('fix the parser', 'terse');
    const once = applyChoiceDirective(styled);
    expect(once.startsWith(styled)).toBe(true);
    expect(applyChoiceDirective(once)).toBe(once);
    expect(once.match(/\[reply-choices\]/g)).toHaveLength(1);
    expect(once.match(/\[reply-style\]/g)).toHaveLength(1);
  });

  it('sends nothing for whitespace-only input', () => {
    expect(applyChoiceDirective('  \n')).toBe('');
  });
});

describe('stripReplyStyle', () => {
  it('is the inverse of applyReplyStyle for display', () => {
    for (const style of ['terse', 'ultra'] as const) {
      expect(stripReplyStyle(applyReplyStyle('fix the parser', style))).toBe('fix the parser');
    }
  });

  it('leaves a prompt without a directive untouched', () => {
    expect(stripReplyStyle('fix the parser')).toBe('fix the parser');
  });

  it('drops the directive and the blank line that introduced it', () => {
    const styled = applyReplyStyle('ship it', 'terse');
    expect(styled).toContain('\n\n[reply-style]');
    expect(stripReplyStyle(styled)).toBe('ship it');
  });

  it('returns empty when the whole message is the directive', () => {
    expect(stripReplyStyle('[reply-style] Answer tersely')).toBe('');
  });
});
