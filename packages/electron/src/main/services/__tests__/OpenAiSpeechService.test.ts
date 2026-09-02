// @vitest-environment node
/**
 * The cloud voice is opt-in and best-effort. What a reader cannot see: an
 * unknown voice must not reach OpenAI as a 400 (it falls back to the default),
 * and Arabic must carry the Cairene delivery hint while English carries none.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTtsRequestBody,
  DEFAULT_OPENAI_TTS_VOICE,
  OPENAI_TTS_MODEL,
  resolveOpenAiVoice,
  ttsInstructionsForLanguage,
} from '../OpenAiSpeechService';

describe('resolveOpenAiVoice', () => {
  it('keeps a known voice and defaults an unknown or missing one', () => {
    expect(resolveOpenAiVoice('shimmer')).toBe('shimmer');
    expect(resolveOpenAiVoice('not-a-voice')).toBe(DEFAULT_OPENAI_TTS_VOICE);
    expect(resolveOpenAiVoice(undefined)).toBe(DEFAULT_OPENAI_TTS_VOICE);
  });
});

describe('ttsInstructionsForLanguage', () => {
  it('adds a Cairene hint for Egyptian Arabic and none for English', () => {
    expect(ttsInstructionsForLanguage('ar-EG')).toMatch(/Egyptian Arabic/i);
    expect(ttsInstructionsForLanguage('en')).toBeUndefined();
    expect(ttsInstructionsForLanguage(undefined)).toBeUndefined();
  });
});

describe('buildTtsRequestBody', () => {
  it('pins the model, plays wav, and omits instructions for English', () => {
    const body = buildTtsRequestBody('hello', { voice: 'echo', language: 'en' });
    expect(body).toMatchObject({ model: OPENAI_TTS_MODEL, voice: 'echo', input: 'hello', response_format: 'wav' });
    expect(body).not.toHaveProperty('instructions');
  });

  it('carries the delivery hint and a safe voice for Egyptian Arabic', () => {
    const body = buildTtsRequestBody('اهلا', { voice: 'bogus', language: 'ar-EG' });
    expect(body.voice).toBe(DEFAULT_OPENAI_TTS_VOICE);
    expect(String(body.instructions)).toMatch(/Egyptian Arabic/i);
  });
});
