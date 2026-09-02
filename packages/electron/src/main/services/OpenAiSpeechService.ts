/**
 * OpenAiSpeechService -- opt-in cloud neural TTS on the CONTROLLER.
 *
 * Piper is a fine offline voice but flat, and it has no natural Egyptian
 * Arabic. When the user turns on "AI voice", the digest is spoken by OpenAI's
 * gpt-4o-mini-tts instead: far more human, multilingual, and steerable to a
 * Cairene delivery. The words come from the digest (already composed in the
 * chosen language on the host); this only turns them into audio.
 *
 * Like piper, playback is local to the machine that hears it -- synthesize the
 * wav, play it with macOS `afplay`, one utterance at a time. Best-effort: with
 * no configured OpenAI key or on any request failure it reports `fallback: true`
 * so the renderer reads the digest with speechSynthesis (which honours the
 * language) rather than wedging on a missing voice.
 *
 * The key comes ONLY from explicit Nimbalyst settings via
 * getProviderApiKeyFromSettings -- never from process.env (CLAUDE.md rule).
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getProviderApiKeyFromSettings } from '../utils/store';
import { logger } from '../utils/logger';
import type { SpeakResult } from './PiperSpeechService';

const log = logger.main;

export const OPENAI_TTS_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
/** gpt-4o-mini-tts: the cheap, human, instruction-steerable multilingual voice. */
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';

/** The voices gpt-4o-mini-tts accepts. Keep in sync with the renderer picker. */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const;
export type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];
export const DEFAULT_OPENAI_TTS_VOICE: OpenAiTtsVoice = 'alloy';

/** An unknown or missing voice falls back to the default rather than a 400. */
export function resolveOpenAiVoice(voice: string | undefined): OpenAiTtsVoice {
  return (OPENAI_TTS_VOICES as readonly string[]).includes(voice ?? '')
    ? (voice as OpenAiTtsVoice)
    : DEFAULT_OPENAI_TTS_VOICE;
}

/**
 * Delivery guidance for the model. The language of the WORDS comes from the
 * input text (the host composes the digest in the chosen language); this only
 * nudges the accent, so it is undefined for English (the model's default is
 * already natural).
 */
export function ttsInstructionsForLanguage(language: string | undefined): string | undefined {
  if (language === 'ar-EG') {
    return 'Speak in warm, natural Egyptian Arabic (Cairene) with clear, friendly, conversational delivery.';
  }
  return undefined;
}

export interface OpenAiSpeakOptions {
  voice?: string;
  language?: string;
}

/** The JSON body for the /v1/audio/speech request. Pure, so it is unit-testable. */
export function buildTtsRequestBody(text: string, options: OpenAiSpeakOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: OPENAI_TTS_MODEL,
    voice: resolveOpenAiVoice(options.voice),
    input: text,
    response_format: 'wav',
  };
  const instructions = ttsInstructionsForLanguage(options.language);
  if (instructions) body.instructions = instructions;
  return body;
}

// One utterance at a time. `synthAbort` cancels an in-flight fetch; `playChild`
// is the afplay process. A new utterance, or a Stop, kills both.
let synthAbort: AbortController | null = null;
let playChild: ChildProcess | null = null;

function killPlayback(): void {
  if (synthAbort) {
    try {
      synthAbort.abort();
    } catch {
      /* already settled */
    }
    synthAbort = null;
  }
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  playChild = null;
}

/** Cancel whatever the cloud voice is saying. */
export function stopOpenAiSpeak(): { success: boolean } {
  killPlayback();
  return { success: true };
}

/** afplay has no pause; freeze it with SIGSTOP and thaw with SIGCONT, like piper. */
export function pauseOpenAiSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGSTOP');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

export function resumeOpenAiSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGCONT');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

/**
 * Synthesize `text` with OpenAI TTS and play it. Resolves when playback ends
 * (or is superseded). Reports `fallback: true` when no OpenAI key is configured
 * or the request fails, so the caller can read it a plainer way.
 */
export async function openAiSpeak(text: string, options: OpenAiSpeakOptions = {}): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: 'empty' };

  const apiKey = getProviderApiKeyFromSettings('openai');
  if (!apiKey) return { success: false, fallback: true, error: 'no openai api key configured' };

  killPlayback(); // latest utterance wins
  const abort = new AbortController();
  synthAbort = abort;

  let audio: Buffer;
  try {
    const res = await fetch(OPENAI_TTS_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTtsRequestBody(trimmed, options)),
      signal: abort.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      log.warn('[OpenAiSpeechService] TTS request failed', res.status, detail);
      return { success: false, fallback: true, error: `openai tts ${res.status}` };
    }
    audio = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (abort.signal.aborted) return { success: true }; // superseded or stopped
    const message = err instanceof Error ? err.message : String(err);
    log.warn('[OpenAiSpeechService] TTS fetch error:', message);
    return { success: false, fallback: true, error: message };
  }

  if (synthAbort !== abort) return { success: true }; // a newer utterance took over

  const outPath = join(tmpdir(), `nimbalyst-openai-speak-${process.pid}.wav`);
  try {
    await writeFile(outPath, audio);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  return new Promise<SpeakResult>((resolve) => {
    let settled = false;
    const done = (result: SpeakResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const play = spawn('afplay', [outPath]);
    playChild = play;
    play.on('error', (err) => {
      log.warn('[OpenAiSpeechService] afplay failed:', err.message);
      done({ success: false, error: err.message });
    });
    play.on('close', () => {
      if (playChild === play) playChild = null;
      done({ success: true });
    });
  });
}
