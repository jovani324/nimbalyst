// @vitest-environment node
/**
 * What a reader cannot see on screen: which reply gets digested. Digesting a
 * streaming fragment, or the assistant turn BEFORE the prompt the user just
 * sent, would speak stale text with full confidence.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { composeUtterance, nextSpeechMode, pickDigestTarget, shouldSpeak, SPEECH_MODES } from '../controllerSpeech';

const vm = (id: number, type: TranscriptViewMessage['type'], text?: string) =>
  ({ id, sequence: id, createdAt: new Date(0), type, text, subagentId: null }) as TranscriptViewMessage;

describe('pickDigestTarget', () => {
  it('takes the last assistant prose once the agent has stopped', () => {
    const messages = [vm(1, 'user_message', 'fix'), vm(2, 'assistant_message', 'Fixed.'), vm(3, 'tool_call'), vm(4, 'turn_ended')];
    expect(pickDigestTarget(messages, false)).toEqual({ id: '2', text: 'Fixed.' });
  });

  it('waits while executing and never reaches past the newest user prompt', () => {
    const messages = [vm(1, 'assistant_message', 'Old.'), vm(2, 'user_message', 'again')];
    expect(pickDigestTarget(messages, true)).toBeNull();
    expect(pickDigestTarget(messages, false)).toBeNull();
  });

  it('skips an assistant turn that was pure tool use', () => {
    expect(pickDigestTarget([vm(1, 'assistant_message', '  ')], false)).toBeNull();
  });
});

describe('shouldSpeak / composeUtterance', () => {
  const digest = { spoken: 'Done. Commit?', kind: 'question' as const, needsYou: true, choices: [{ label: 'yes', prompt: 'Yes.' }] };

  it('speaks only what the mode allows', () => {
    expect(shouldSpeak(digest, 'off')).toBe(false);
    expect(shouldSpeak(digest, 'needs-you')).toBe(true);
    expect(shouldSpeak({ ...digest, needsYou: false }, 'needs-you')).toBe(false);
    expect(shouldSpeak({ ...digest, needsYou: false }, 'all')).toBe(true);
  });

  it('reads the choices after the digest, and nothing extra without them', () => {
    expect(composeUtterance(digest)).toBe('Done. Commit? one, yes.');
    expect(composeUtterance({ ...digest, choices: [] })).toBe('Done. Commit?');
  });

  it('cycles every mode and wraps', () => {
    let mode = SPEECH_MODES[0];
    for (let i = 0; i < SPEECH_MODES.length; i++) mode = nextSpeechMode(mode);
    expect(mode).toBe(SPEECH_MODES[0]);
  });
});
