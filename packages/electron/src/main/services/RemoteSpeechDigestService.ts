/**
 * RemoteSpeechDigestService — turn an agent reply into a few spoken sentences
 * plus the answers a keypress can give, on the HOST.
 *
 * The controller plays audio; it cannot run a model. It sends the reply text
 * over the session-control channel, this drives a one-shot `claude -p` here and
 * sends the digest back matched by requestId. Same shape, flags and trust as
 * RemotePromptCompactService; the differences are structured output, a cheap
 * pinned model (this fires per reply, compaction is manual), a cache keyed by
 * message id, and an encrypted payload -- a digest is a summary of real work
 * and control messages otherwise cross the relay in the clear.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import {
  buildSpeechDigestSystemPrompt,
  isSpeechLanguage,
  parseSpeechDigest,
  SPEECH_DIGEST_SCHEMA,
  toSpeakable,
  type SpeechDigest,
  type SpeechLanguage,
} from '@nimbalyst/runtime/ai/prompts/speechDigest';
import { getPersonalDocSyncConfig, getSyncProvider } from './SyncManager';
import { resolveSessionCwd } from './RemoteTerminalService';
import { resolveClaudeExecutablePath, isClaudeExecutableInstalled } from './ai/claudeExecutableResolver';
import { getEnhancedPath } from './CLIManager';
import { logger } from '../utils/logger';

const log = logger.main;

/** One reply, not a transcript. Shaped text is much shorter than the raw message. */
export const MAX_DIGEST_INPUT_CHARS = 12000;
export const DIGEST_TIMEOUT_MS = 90_000;
/** Cheapest alias the CLI knows; the ladder drops it if the host's CLI does not. */
export const SPEECH_DIGEST_MODEL = 'haiku';
const CACHE_LIMIT = 200;

/** The system prompt is language-specific, so the args are built per request. */
function sharedArgs(language: SpeechLanguage): string[] {
  return ['-p', '--append-system-prompt', buildSpeechDigestSystemPrompt(language)];
}

/** Full flags: no settings, no tools, schema-enforced JSON, cheap model. */
export function buildDigestArgs(language: SpeechLanguage = 'en'): string[] {
  return [
    ...sharedArgs(language),
    '--setting-sources',
    '',
    '--tools',
    '',
    '--model',
    SPEECH_DIGEST_MODEL,
    '--json-schema',
    JSON.stringify(SPEECH_DIGEST_SCHEMA),
  ];
}

/** What an older CLI can run: the parser copes with prose around the JSON. */
export function buildLegacyDigestArgs(language: SpeechLanguage = 'en'): string[] {
  return [...sharedArgs(language), '--model', SPEECH_DIGEST_MODEL];
}

/** Last rung: no model pin either. */
export function buildBareDigestArgs(language: SpeechLanguage = 'en'): string[] {
  return [...sharedArgs(language)];
}

export function isUnknownOptionError(stderr: string): boolean {
  return /unknown option/i.test(stderr) && /--setting-sources|--tools|--json-schema/.test(stderr);
}

export function isUnknownModelError(stderr: string): boolean {
  return /model/i.test(stderr) && /not found|unknown|invalid|unsupported|does not exist/i.test(stderr);
}

export interface RunDigestOptions {
  cwd: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The language to speak the digest in. Defaults to English. */
  language?: SpeechLanguage;
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 300) : '';
}

/**
 * Drive `claude -p` over stdin and parse the digest. Walks the flag ladder
 * when the CLI rejects a flag or the model alias, so a stale host still
 * answers. Rejects with a message meant for the UI.
 */
export async function runDigest(text: string, options: RunDigestOptions): Promise<SpeechDigest> {
  const executable =
    options.executable ??
    resolveClaudeExecutablePath({ homedir: os.homedir(), pathExists: existsSync, enhancedPath: getEnhancedPath() });

  const language = options.language ?? 'en';
  const ladder: Array<{ args: string[]; retryOn: (stderr: string) => boolean }> = [
    { args: buildDigestArgs(language), retryOn: (e) => isUnknownOptionError(e) || isUnknownModelError(e) },
    { args: buildLegacyDigestArgs(language), retryOn: isUnknownModelError },
    { args: buildBareDigestArgs(language), retryOn: () => false },
  ];

  let output = '';
  for (let i = 0; i < ladder.length; i++) {
    try {
      output = await runDigestWith(text, options, executable, ladder[i].args);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (i < ladder.length - 1 && ladder[i].retryOn(message)) {
        log.warn('[RemoteSpeechDigestService] claude rejected a flag; retrying without it:', message);
        continue;
      }
      throw err;
    }
  }

  const digest = parseSpeechDigest(output);
  if (!digest) throw new Error('The digest came back unreadable.');
  return digest;
}

function runDigestWith(text: string, options: RunDigestOptions, executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? { ...process.env, PATH: getEnhancedPath() || process.env.PATH },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('Digest timed out.')));
    }, options.timeoutMs ?? DIGEST_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      finish(() => reject(new Error(`Could not run the claude CLI: ${err.message}`)));
    });
    child.on('close', (code) => {
      finish(() => {
        const out = stdout.trim();
        if (code !== 0) {
          const message = firstMeaningfulLine(stderr) || `claude exited with code ${code}.`;
          log.warn('[RemoteSpeechDigestService] claude exited', code, '-', message);
          reject(new Error(message));
          return;
        }
        if (!out) {
          reject(new Error('The digest came back empty.'));
          return;
        }
        resolve(out);
      });
    });

    child.stdin?.on('error', () => {
      /* the close handler already reports why the process went away */
    });
    child.stdin?.end(text);
  });
}

// ---------------------------------------------------------------------------
// Payload encryption -- the same AES-GCM + base64 shape the transcript uses.
// ---------------------------------------------------------------------------

export async function encryptDigestPayload(
  digest: SpeechDigest,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(digest));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    encrypted: Buffer.from(new Uint8Array(encrypted)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

export async function decryptDigestPayload(encrypted: string, iv: string, key: CryptoKey): Promise<SpeechDigest> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
    key,
    Buffer.from(encrypted, 'base64')
  );
  const digest = parseSpeechDigest(new TextDecoder().decode(decrypted));
  if (!digest) throw new Error('The digest payload did not decrypt to a digest.');
  return digest;
}

// ---------------------------------------------------------------------------
// Control lane
// ---------------------------------------------------------------------------

/** Digests already paid for, by message id. Bounded so a long day does not grow it. */
const cache = new Map<string, SpeechDigest>();

function remember(messageId: string, digest: SpeechDigest): void {
  if (!messageId) return;
  cache.delete(messageId);
  cache.set(messageId, digest);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Exposed for tests. */
export function clearSpeechDigestCache(): void {
  cache.clear();
}

async function send(sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const provider = getSyncProvider();
  if (!provider?.sendSessionControlMessage) return;
  try {
    await provider.sendSessionControlMessage({
      sessionId,
      type,
      payload,
      timestamp: Date.now(),
      sentBy: 'desktop',
    });
  } catch (err) {
    log.warn('[RemoteSpeechDigestService] Failed to relay digest message:', err);
  }
}

async function digestForDevice(
  sessionId: string,
  requestId: string,
  messageId: string,
  text: string,
  language: SpeechLanguage,
): Promise<void> {
  const key = getPersonalDocSyncConfig()?.encryptionKeyRaw;
  if (!key) {
    await send(sessionId, 'speech_digest_error', { requestId, messageId, error: 'The host has no encryption key.' });
    return;
  }

  // Namespace the cache by session: message ids are per-session (m.id ?? index),
  // so two sessions share id "3" and an un-namespaced key hands one session the
  // other's digest -- the reply you hear then belongs to a different session.
  // The language is part of the key too: the same reply spoken in English and in
  // Arabic are different digests and must not overwrite each other.
  const cacheKey = `${sessionId}:${messageId}:${language}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    await send(sessionId, 'speech_digested', { requestId, messageId, ...(await encryptDigestPayload(cached, key)) });
    return;
  }

  const shaped = toSpeakable(text);
  if (!shaped) {
    await send(sessionId, 'speech_digest_error', { requestId, messageId, error: 'Nothing to say.' });
    return;
  }
  if (shaped.length > MAX_DIGEST_INPUT_CHARS) {
    await send(sessionId, 'speech_digest_error', {
      requestId,
      messageId,
      error: `That reply is too long to digest (limit ${MAX_DIGEST_INPUT_CHARS} characters).`,
    });
    return;
  }
  if (!isClaudeExecutableInstalled({ homedir: os.homedir(), pathExists: existsSync, enhancedPath: getEnhancedPath() })) {
    await send(sessionId, 'speech_digest_error', {
      requestId,
      messageId,
      error: 'The claude CLI is not installed on the host.',
    });
    return;
  }

  try {
    const cwd = await resolveSessionCwd(sessionId);
    const digest = await runDigest(shaped, { cwd, language });
    remember(cacheKey, digest);
    await send(sessionId, 'speech_digested', { requestId, messageId, ...(await encryptDigestPayload(digest, key)) });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Digest failed.';
    log.warn('[RemoteSpeechDigestService] digest failed for', sessionId, '-', error);
    await send(sessionId, 'speech_digest_error', { requestId, messageId, error });
  }
}

/**
 * Handle a `speech_digest` session-control message from a paired device.
 * Returns false when the message isn't one of ours, so the caller keeps
 * dispatching.
 */
export function handleRemoteSpeechDigestControl(message: {
  sessionId: string;
  type: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (message.type !== 'speech_digest') return false;

  const payload = message.payload ?? {};
  const requestId = String(payload.requestId ?? '');
  if (!requestId) return true;

  // Absent or unknown language falls back to English, so an older controller
  // that never sends the field keeps working.
  const language: SpeechLanguage = isSpeechLanguage(payload.language) ? payload.language : 'en';
  void digestForDevice(
    message.sessionId,
    requestId,
    String(payload.messageId ?? ''),
    String(payload.text ?? ''),
    language,
  );
  return true;
}
