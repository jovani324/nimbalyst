// @vitest-environment node
/**
 * The disguise is only convincing if it holds still: a session whose fake file
 * path changed between renders (or between the list and the header) would be a
 * louder tell than no disguise at all.
 */
import { describe, expect, it } from 'vitest';
import { disguisedCode, disguisedName } from '../controllerDisguise';

describe('controller disguise', () => {
  it('gives a session the same fake path every time', () => {
    expect(disguisedName('session-abc')).toBe(disguisedName('session-abc'));
    expect(disguisedName('session-abc')).not.toBe(disguisedName('session-xyz'));
  });

  it('produces a plausible source path', () => {
    expect(disguisedName('session-abc')).toMatch(/^[a-z/]+\/[a-z]+\.(ts|tsx|go|py|rs)$/);
  });

  it('rotates the fake source per session but keeps it stable', () => {
    const a = disguisedCode('session-abc');
    expect(disguisedCode('session-abc')).toEqual(a);
    expect(a).toHaveLength(disguisedCode('session-xyz').length);
    expect(a.join('\n')).not.toBe(disguisedCode('session-xyz').join('\n'));
  });
});
