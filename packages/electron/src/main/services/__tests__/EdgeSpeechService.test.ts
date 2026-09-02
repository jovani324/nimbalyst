// @vitest-environment node
/**
 * The free Edge voice signs each request with a time-bucketed token and speaks
 * whichever language the digest is in. What a reader cannot see: the token must
 * be stable within a 5-minute bucket (or every utterance re-handshakes), the
 * SSML must escape user text, and Egyptian Arabic must pick an ar-EG voice --
 * not an English one -- while OpenAI-style voice ids are ignored here.
 */
import { describe, expect, it } from 'vitest';
import {
  buildEdgeSsml,
  edgeVoiceForLanguage,
  escapeXml,
  generateSecMsGec,
} from '../EdgeSpeechService';

describe('edgeVoiceForLanguage', () => {
  it('defaults to a native voice per language and ignores OpenAI voice ids', () => {
    expect(edgeVoiceForLanguage('en')).toBe('en-US-AriaNeural');
    expect(edgeVoiceForLanguage('ar-EG')).toBe('ar-EG-SalmaNeural');
    // "alloy" is an OpenAI voice, not an Edge one -- must not leak through.
    expect(edgeVoiceForLanguage('ar-EG', 'alloy')).toBe('ar-EG-SalmaNeural');
  });

  it('honours an explicit Edge voice for the language', () => {
    expect(edgeVoiceForLanguage('ar-EG', 'ar-EG-ShakirNeural')).toBe('ar-EG-ShakirNeural');
  });
});

describe('buildEdgeSsml', () => {
  it('wraps the voice with its xml:lang and escapes the text', () => {
    const ssml = buildEdgeSsml('a & b <c>', 'ar-EG-SalmaNeural');
    expect(ssml).toContain("xml:lang='ar-EG'");
    expect(ssml).toContain("<voice name='ar-EG-SalmaNeural'>");
    expect(ssml).toContain('a &amp; b &lt;c&gt;');
  });
});

describe('escapeXml', () => {
  it('escapes the five xml specials', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('generateSecMsGec', () => {
  const t = 1_700_000_000_000; // fixed base so the test never reads the clock

  it('is an uppercase 64-hex digest', () => {
    expect(generateSecMsGec(t)).toMatch(/^[0-9A-F]{64}$/);
  });

  it('is stable within a 5-minute bucket and changes across buckets', () => {
    expect(generateSecMsGec(t + 60_000)).toBe(generateSecMsGec(t));
    expect(generateSecMsGec(t + 300_000)).not.toBe(generateSecMsGec(t));
  });
});
