// @vitest-environment node
/**
 * The digest parser has to survive three CLIs: one that honours --json-schema,
 * one that wraps the answer in its own json envelope, and one that returns prose
 * around a fenced object. What a reader cannot see: a parse miss must yield
 * null (so the client speaks the shaped text) and never a digest with choices
 * the model did not propose -- a keypress sends those.
 */
import { describe, expect, it } from 'vitest';
import {
  fallbackDigest,
  fallbackSpoken,
  parseSpeechDigest,
  spokenChoices,
  toSpeakable,
} from '../speechDigest';

describe('toSpeakable', () => {
  it('drops fences, tool envelopes and diff lines but keeps the prose', () => {
    const raw = [
      'Updated the parser.',
      '```ts',
      'const x = 1;',
      '```',
      '<tool_use>{"name":"Edit"}</tool_use>',
      'diff --git a/src/p.ts b/src/p.ts',
      '--- a/src/p.ts',
      '+++ b/src/p.ts',
      '@@ -1,2 +1,2 @@',
      '-const old = 1;',
      '+const next = 2;',
      'Tests pass. Want me to commit?',
    ].join('\n');
    const out = toSpeakable(raw);
    expect(out).toContain('Updated the parser.');
    expect(out).toContain('Want me to commit?');
    expect(out).not.toMatch(/const|diff|@@|tool_use/);
  });

  it('collapses paths to basenames, urls to "link", and removes hashes', () => {
    const out = toSpeakable('See packages/electron/src/main/index.ts and https://x.y/z at e2a763f20.');
    expect(out).toContain('index.ts');
    expect(out).not.toContain('packages/electron');
    expect(out).toContain('link');
    expect(out).not.toContain('e2a763f20');
  });

  it('strips markdown emphasis, headings and bullets', () => {
    expect(toSpeakable('## Done\n- **all** tests `pass`')).toBe('Done\nall tests pass');
  });
});

describe('fallbackSpoken / fallbackDigest', () => {
  it('speaks only the first sentence and proposes no choices', () => {
    const digest = fallbackDigest('Fixed it. Then I also ran the suite. Ask me anything.');
    expect(digest.spoken).toBe('Fixed it.');
    expect(digest.kind).toBe('progress');
    expect(digest.needsYou).toBe(false);
    expect(digest.choices).toEqual([]);
  });

  it('clamps a sentence that never ends', () => {
    expect(fallbackSpoken('a'.repeat(300), 50)).toHaveLength(50);
  });
});

describe('parseSpeechDigest', () => {
  const valid = {
    spoken: 'This session fixed the parser and the tests pass. It asks whether to commit.',
    kind: 'question',
    needsYou: true,
    choices: [
      { label: 'yes commit', prompt: 'Yes, commit it.' },
      { label: 'not yet', prompt: 'Do not commit yet.' },
    ],
  };

  it('accepts clean schema output', () => {
    expect(parseSpeechDigest(JSON.stringify(valid))).toEqual(valid);
  });

  it('unwraps the CLI json envelope, as string or object', () => {
    expect(parseSpeechDigest(JSON.stringify({ type: 'result', result: JSON.stringify(valid) }))).toEqual(valid);
    expect(parseSpeechDigest(JSON.stringify({ structured_output: valid }))).toEqual(valid);
  });

  it('finds a fenced or prose-wrapped object on the legacy path', () => {
    expect(parseSpeechDigest(`Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
    expect(parseSpeechDigest(`Sure. ${JSON.stringify(valid)} Hope that helps.`)).toEqual(valid);
  });

  it('repairs a partial object instead of rejecting it', () => {
    const out = parseSpeechDigest(JSON.stringify({ spoken: 'Waiting on approval.', kind: 'permission' }));
    expect(out).toEqual({ spoken: 'Waiting on approval.', kind: 'permission', needsYou: true, choices: [] });
  });

  it('caps choices at three and drops malformed ones', () => {
    const out = parseSpeechDigest(
      JSON.stringify({
        spoken: 'x',
        kind: 'question',
        choices: [{ label: 'a' }, { nope: 1 }, { label: 'b', prompt: 'B' }, { label: 'c' }, { label: 'd' }],
      })
    );
    expect(out?.choices.map((c) => c.label)).toEqual(['a', 'b', 'c']);
    expect(out?.choices[0].prompt).toBe('a');
  });

  it('returns null for garbage, empty spoken, and an unknown kind without text', () => {
    expect(parseSpeechDigest('nothing here')).toBeNull();
    expect(parseSpeechDigest('{"spoken":""}')).toBeNull();
    expect(parseSpeechDigest('')).toBeNull();
    expect(parseSpeechDigest(JSON.stringify({ spoken: 'ok', kind: 'weird' }))?.kind).toBe('progress');
  });
});

describe('spokenChoices', () => {
  it('numbers in words with a trailing stop each', () => {
    expect(spokenChoices([{ label: 'approve', prompt: 'y' }, { label: 'run tests.', prompt: 't' }])).toBe(
      'one, approve. two, run tests.'
    );
  });
});
