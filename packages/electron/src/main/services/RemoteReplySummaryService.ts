/**
 * RemoteReplySummaryService — summarize one agent reply into a couple of plain
 * sentences, on the HOST. Sibling of RemoteSpeechDigestService with the same
 * trust, flags, cache-by-message-id and encrypted payload; the differences are a
 * plain-string result (no schema, no choices) and a summary system prompt. The
 * controller sends the reply text over the session-control channel, this drives a
 * one-shot `claude -p` and sends the summary back matched by requestId.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import {
  buildReplySummarySystemPrompt,
  normalizeReplySummary,
  MAX_SUMMARY_INPUT_CHARS,
} from '@nimbalyst/runtime/ai/prompts/replySummary';
import { getPersonalDocSyncConfig, getSyncProvider } from './SyncManager';
import { resolveSessionCwd } from './RemoteTerminalService';
import { resolveClaudeExecutablePath, isClaudeExecutableInstalled } from './ai/claudeExecutableResolver';
import { getEnhancedPath } from './CLIManager';
import { logger } from '../utils/logger';

const log = logger.main;

export const SUMMARY_TIMEOUT_MS = 90_000;
export const REPLY_SUMMARY_MODEL = 'haiku';
const CACHE_LIMIT = 200;

const SHARED_ARGS = ['-p', '--append-system-prompt', buildReplySummarySystemPrompt()];

/** Full flags: no settings, no tools, cheap model. No JSON schema — the result is prose. */
export function buildSummaryArgs(): string[] {
  return [...SHARED_ARGS, '--setting-sources', '', '--tools', '', '--model', REPLY_SUMMARY_MODEL];
}

/** What an older CLI can run: drop the flags a stale build rejects. */
export function buildLegacySummaryArgs(): string[] {
  return [...SHARED_ARGS, '--model', REPLY_SUMMARY_MODEL];
}

/** Last rung: no model pin either. */
export function buildBareSummaryArgs(): string[] {
  return [...SHARED_ARGS];
}

export function isUnknownOptionError(stderr: string): boolean {
  return /unknown option/i.test(stderr) && /--setting-sources|--tools/.test(stderr);
}
export function isUnknownModelError(stderr: string): boolean {
  return /model/i.test(stderr) && /not found|unknown|invalid|unsupported|does not exist/i.test(stderr);
}

export interface RunSummaryOptions {
  cwd: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 300) : '';
}

/** Drive `claude -p` over stdin and return the summary text, walking the flag ladder. */
export async function runSummary(text: string, options: RunSummaryOptions): Promise<string> {
  const executable =
    options.executable ??
    resolveClaudeExecutablePath({ homedir: os.homedir(), pathExists: existsSync, enhancedPath: getEnhancedPath() });

  const ladder: Array<{ args: string[]; retryOn: (stderr: string) => boolean }> = [
    { args: buildSummaryArgs(), retryOn: (e) => isUnknownOptionError(e) || isUnknownModelError(e) },
    { args: buildLegacySummaryArgs(), retryOn: isUnknownModelError },
    { args: buildBareSummaryArgs(), retryOn: () => false },
  ];

  let output = '';
  for (let i = 0; i < ladder.length; i++) {
    try {
      output = await runSummaryWith(text, options, executable, ladder[i].args);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (i < ladder.length - 1 && ladder[i].retryOn(message)) {
        log.warn('[RemoteReplySummaryService] claude rejected a flag; retrying without it:', message);
        continue;
      }
      throw err;
    }
  }

  const summary = normalizeReplySummary(output);
  if (!summary) throw new Error('The summary came back empty.');
  return summary;
}

function runSummaryWith(text: string, options: RunSummaryOptions, executable: string, args: string[]): Promise<string> {
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
      finish(() => reject(new Error('Summary timed out.')));
    }, options.timeoutMs ?? SUMMARY_TIMEOUT_MS);

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
          log.warn('[RemoteReplySummaryService] claude exited', code, '-', message);
          reject(new Error(message));
          return;
        }
        if (!out) {
          reject(new Error('The summary came back empty.'));
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

// --- Payload encryption: the same AES-GCM + base64 shape the digest uses. -----

export async function encryptSummaryPayload(
  summary: string,
  key: CryptoKey,
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(summary);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    encrypted: Buffer.from(new Uint8Array(encrypted)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

export async function decryptSummaryPayload(encrypted: string, iv: string, key: CryptoKey): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
    key,
    Buffer.from(encrypted, 'base64'),
  );
  return new TextDecoder().decode(decrypted);
}

// --- Control lane -------------------------------------------------------------

const cache = new Map<string, string>();

function remember(cacheKey: string, summary: string): void {
  if (!cacheKey) return;
  cache.delete(cacheKey);
  cache.set(cacheKey, summary);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Exposed for tests. */
export function clearReplySummaryCache(): void {
  cache.clear();
}

async function send(sessionId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const provider = getSyncProvider();
  if (!provider?.sendSessionControlMessage) return;
  try {
    await provider.sendSessionControlMessage({ sessionId, type, payload, timestamp: Date.now(), sentBy: 'desktop' });
  } catch (err) {
    log.warn('[RemoteReplySummaryService] Failed to relay summary message:', err);
  }
}

async function summarizeForDevice(
  sessionId: string,
  requestId: string,
  messageId: string,
  text: string,
): Promise<void> {
  const key = getPersonalDocSyncConfig()?.encryptionKeyRaw;
  if (!key) {
    await send(sessionId, 'reply_summarize_error', { requestId, messageId, error: 'The host has no encryption key.' });
    return;
  }

  // Namespace the cache by session — message ids repeat across sessions.
  const cacheKey = `${sessionId}:${messageId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    await send(sessionId, 'reply_summarized', { requestId, messageId, ...(await encryptSummaryPayload(cached, key)) });
    return;
  }

  const shaped = text.trim();
  if (!shaped) {
    await send(sessionId, 'reply_summarize_error', { requestId, messageId, error: 'Nothing to summarize.' });
    return;
  }
  const clamped = shaped.length > MAX_SUMMARY_INPUT_CHARS ? shaped.slice(0, MAX_SUMMARY_INPUT_CHARS) : shaped;
  if (!isClaudeExecutableInstalled({ homedir: os.homedir(), pathExists: existsSync, enhancedPath: getEnhancedPath() })) {
    await send(sessionId, 'reply_summarize_error', {
      requestId,
      messageId,
      error: 'The claude CLI is not installed on the host.',
    });
    return;
  }

  try {
    const cwd = await resolveSessionCwd(sessionId);
    const summary = await runSummary(clamped, { cwd });
    remember(cacheKey, summary);
    await send(sessionId, 'reply_summarized', { requestId, messageId, ...(await encryptSummaryPayload(summary, key)) });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Summary failed.';
    log.warn('[RemoteReplySummaryService] summary failed for', sessionId, '-', error);
    await send(sessionId, 'reply_summarize_error', { requestId, messageId, error });
  }
}

/**
 * Handle a `summarize_reply` session-control message. Returns false when the
 * message isn't ours, so the caller keeps dispatching.
 */
export function handleRemoteSummarizeReplyControl(message: {
  sessionId: string;
  type: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (message.type !== 'summarize_reply') return false;
  const payload = message.payload ?? {};
  const requestId = String(payload.requestId ?? '');
  if (!requestId) return true;
  void summarizeForDevice(message.sessionId, requestId, String(payload.messageId ?? ''), String(payload.text ?? ''));
  return true;
}
