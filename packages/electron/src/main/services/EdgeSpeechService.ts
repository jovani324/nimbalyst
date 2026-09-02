/**
 * EdgeSpeechService -- FREE neural TTS on the CONTROLLER, no API key.
 *
 * Microsoft Edge's "read aloud" uses online neural voices, and the same
 * endpoint the `edge-tts` project reverse-engineered is reachable without an
 * account. It gives genuinely human voices and, unlike piper or the OS voices,
 * a real Egyptian Arabic (ar-EG-SalmaNeural / ar-EG-ShakirNeural). That makes
 * it the best FREE option for this feature.
 *
 * Caveat: it is an UNOFFICIAL endpoint. It can change or disappear, and the
 * request is signed with a time-based Sec-MS-GEC token that Microsoft rotates.
 * So this is best-effort like the others: any failure reports `fallback: true`
 * and the renderer reads the digest with the browser voice (which still honours
 * the language) rather than wedging.
 *
 * Playback is local (macOS `afplay`), one utterance at a time, matching piper
 * and the OpenAI voice.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { logger } from '../utils/logger';
import type { SpeakResult } from './PiperSpeechService';

const log = logger.main;

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const SEC_MS_GEC_VERSION = '1-130.0.2849.68';
const WIN_EPOCH = 11644473600n;
const EDGE_TIMEOUT_MS = 15_000;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** The Egyptian Arabic and English Edge voices offered. Keep in sync with the picker. */
export const EDGE_VOICES_BY_LANGUAGE: Record<string, readonly string[]> = {
  en: ['en-US-AriaNeural', 'en-US-GuyNeural', 'en-US-JennyNeural'],
  'ar-EG': ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural'],
};

/**
 * The Edge voice to use. An explicit Edge voice (…Neural) wins; otherwise the
 * first voice for the language, so English and Egyptian Arabic each get a
 * native-sounding default. (OpenAI voice ids like "alloy" are ignored here.)
 */
export function edgeVoiceForLanguage(language: string | undefined, voice?: string): string {
  const lang = language === 'ar-EG' ? 'ar-EG' : 'en';
  const list = EDGE_VOICES_BY_LANGUAGE[lang];
  if (voice && /Neural$/.test(voice) && list.includes(voice)) return voice;
  return list[0];
}

function xmlLangForVoice(voice: string): string {
  // "ar-EG-SalmaNeural" -> "ar-EG"; "en-US-AriaNeural" -> "en-US".
  const parts = voice.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildEdgeSsml(text: string, voice: string): string {
  const lang = xmlLangForVoice(voice);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`
  );
}

/**
 * The time-based token Microsoft requires. Rounds the Windows-epoch tick down to
 * a 5-minute bucket and SHA-256s it with the trusted token. BigInt because the
 * tick overflows a JS number after scaling to 100ns units.
 */
export function generateSecMsGec(nowMs: number = Date.now()): string {
  let ticks = BigInt(Math.floor(nowMs / 1000)) + WIN_EPOCH;
  ticks -= ticks % 300n; // round down to the nearest 5 minutes
  ticks *= 10_000_000n; // seconds -> 100-nanosecond intervals
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function edgeUrl(nowMs?: number): string {
  const params = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    'Sec-MS-GEC': generateSecMsGec(nowMs),
    'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
  });
  return `${WSS_BASE}?${params.toString()}`;
}

export function buildConfigMessage(timestamp: string): string {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  };
  return (
    `X-Timestamp:${timestamp}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    JSON.stringify(config)
  );
}

export function buildSsmlMessage(requestId: string, timestamp: string, ssml: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${timestamp}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

export interface EdgeSpeakOptions {
  language?: string;
  voice?: string;
}

// One utterance at a time. A new utterance, or Stop, closes the socket and
// kills the player.
let currentSocket: WebSocket | null = null;
let playChild: ChildProcess | null = null;

function killPlayback(): void {
  if (currentSocket) {
    try {
      currentSocket.close();
    } catch {
      /* already closed */
    }
    currentSocket = null;
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

export function stopEdgeSpeak(): { success: boolean } {
  killPlayback();
  return { success: true };
}

export function pauseEdgeSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGSTOP');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

export function resumeEdgeSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGCONT');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

/** Collect the mp3 stream over the websocket, then resolve with the audio bytes. */
function synthesizeEdgeAudio(text: string, voice: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(edgeUrl(), {
      headers: {
        Origin: 'chrome-extension://jdiccldimpahaajaddgadplghjcaengk',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      },
    });
    currentSocket = ws;

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (currentSocket === ws) currentSocket = null;
      fn();
    };

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error('Edge TTS timed out.')));
    }, EDGE_TIMEOUT_MS);

    ws.on('open', () => {
      const timestamp = new Date().toString();
      ws.send(buildConfigMessage(timestamp));
      ws.send(buildSsmlMessage(randomUUID().replace(/-/g, ''), timestamp, buildEdgeSsml(text, voice)));
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (data.toString('utf8').includes('Path:turn.end')) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          finish(() => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error('Edge TTS returned no audio.'))));
        }
        return;
      }
      // Binary frame: [uint16 header length][header][audio].
      if (data.length < 2) return;
      const headerLen = data.readUInt16BE(0);
      const audio = data.subarray(2 + headerLen);
      if (audio.length) chunks.push(Buffer.from(audio));
    });

    ws.on('error', (err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
    ws.on('close', () => {
      finish(() => (chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error('Edge TTS closed early.'))));
    });
  });
}

/**
 * Synthesize `text` with Edge's neural voice for the chosen language and play
 * it. Reports `fallback: true` on any failure so the caller reads it plainer.
 */
export async function edgeSpeak(text: string, options: EdgeSpeakOptions = {}): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: 'empty' };

  killPlayback(); // latest utterance wins
  const voice = edgeVoiceForLanguage(options.language, options.voice);

  let audio: Buffer;
  try {
    audio = await synthesizeEdgeAudio(trimmed, voice);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('[EdgeSpeechService] synthesis failed:', message);
    return { success: false, fallback: true, error: message };
  }

  const outPath = join(tmpdir(), `nimbalyst-edge-speak-${process.pid}.mp3`);
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
      log.warn('[EdgeSpeechService] afplay failed:', err.message);
      done({ success: false, error: err.message });
    });
    play.on('close', () => {
      if (playChild === play) playChild = null;
      done({ success: true });
    });
  });
}
