/**
 * RemoteFileService — read a file from the HOST for a paired device.
 *
 * The controller runs on a different machine, so a file reference in a
 * transcript ("packages/electron/src/main/index.ts:42") points at something the
 * controller cannot open: the repo only exists here. This answers `file_read`
 * over the same session-control channel the remote terminal uses, so tapping a
 * reference shows the real file.
 *
 * Reads are confined to the session's own working directory (its worktree, for
 * worktree sessions) and follow symlinks before checking, so a link inside the
 * checkout cannot be used to walk out of it. Trust is the same as the remote
 * terminal's — a paired device can already run commands here — but the boundary
 * is drawn narrowly anyway, because a viewer has no reason to be wider.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { shell } from 'electron';
import { getSyncProvider } from './SyncManager';
import { resolveSessionCwd } from './RemoteTerminalService';
import { resolveSavedAttachmentDirectory, resolveWorkspaceAttachmentStagingDirectory } from './attachments/attachmentStagingRoot';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

const log = logger.main;

/** A single relay message carries the whole file, so it has to stay modest. */
export const MAX_FILE_BYTES = 96 * 1024;
/** Even a small file can be one enormous line; cap what the viewer receives. */
export const MAX_FILE_LINES = 2000;

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
    log.warn('[RemoteFileService] Failed to relay file message:', err);
  }
}

/**
 * Resolve a requested path inside `root`, or return null if it escapes.
 * Both sides are realpath'd first so a symlink pointing outside is rejected
 * rather than followed.
 */
export async function resolveInsideRoot(root: string, requested: string): Promise<string | null> {
  if (!requested || requested.includes('\0')) return null;
  const absolute = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(absolute);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return realTarget;
}

async function readRemoteFile(sessionId: string, requestId: string, requested: string): Promise<void> {
  const root = await resolveSessionCwd(sessionId);
  const target = await resolveInsideRoot(root, requested);
  if (!target) {
    await send(sessionId, 'file_error', {
      requestId,
      error: 'That path is outside the session folder, or does not exist.',
    });
    return;
  }

  let raw: Buffer;
  let truncated = false;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      await send(sessionId, 'file_error', { requestId, error: 'Not a file.' });
      return;
    }
    const handle = await fs.open(target, 'r');
    try {
      raw = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
      await handle.read(raw, 0, raw.length, 0);
    } finally {
      await handle.close();
    }
    truncated = stat.size > MAX_FILE_BYTES;
  } catch (err) {
    await send(sessionId, 'file_error', {
      requestId,
      error: err instanceof Error ? err.message : 'Could not read that file.',
    });
    return;
  }

  // A NUL in the first block is the cheap, reliable "this is not source" test.
  if (raw.subarray(0, 8192).includes(0)) {
    await send(sessionId, 'file_error', { requestId, error: 'That file is binary.' });
    return;
  }

  let text = raw.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > MAX_FILE_LINES) {
    text = lines.slice(0, MAX_FILE_LINES).join('\n');
    truncated = true;
  }

  await send(sessionId, 'file_content', {
    requestId,
    path: path.relative(root, target) || path.basename(target),
    text,
    truncated,
  });
}

/**
 * Locate a staged attachment by the bare `@filename` a transcript shows. Saved
 * attachments live at `<stagingRoot>/saved/<sessionId>/<timestamp>_<name>`, so
 * the on-disk name carries a timestamp the reference dropped: match on that
 * suffix, and confine the hit to the session's own attachment folder.
 */
export async function resolveStagedAttachment(sessionId: string, requested: string): Promise<string | null> {
  const base = path.basename(requested);
  // An attachment mention is a bare name; a path with directories is a repo
  // file, which resolveInsideRoot already handled before we got here.
  if (!base || base !== requested) return null;

  let workspacePath: string | undefined;
  try {
    workspacePath = (await AISessionsRepository.get(sessionId))?.workspacePath;
  } catch {
    return null;
  }
  if (!workspacePath) return null;

  const sessionDir = path.join(
    resolveSavedAttachmentDirectory(resolveWorkspaceAttachmentStagingDirectory(workspacePath)),
    sessionId,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(sessionDir);
  } catch {
    return null;
  }

  const matches = entries.filter((name) => name === base || name.endsWith(`_${base}`));
  // The same name can recur across turns; the newest staged copy is the one the
  // reference most likely means.
  let best: { name: string; mtime: number } | null = null;
  for (const name of matches) {
    try {
      const stat = await fs.stat(path.join(sessionDir, name));
      if (!best || stat.mtimeMs > best.mtime) best = { name, mtime: stat.mtimeMs };
    } catch {
      // A racing cleanup can remove an entry between readdir and stat; skip it.
    }
  }
  if (!best) return null;
  return resolveInsideRoot(sessionDir, best.name);
}

/**
 * Open a picture on the HOST's default app. A repo file (including a relative
 * image path the agent named) resolves inside the session folder; a bare
 * `@filename` mention falls back to the session's attachment staging folder.
 */
async function openRemoteFile(sessionId: string, requestId: string, requested: string): Promise<void> {
  const root = await resolveSessionCwd(sessionId);
  let target = await resolveInsideRoot(root, requested);
  if (!target) target = await resolveStagedAttachment(sessionId, requested);
  if (!target) {
    await send(sessionId, 'file_open_error', {
      requestId,
      error: 'That path is outside the session folder, or does not exist.',
    });
    return;
  }

  try {
    if (!(await fs.stat(target)).isFile()) {
      await send(sessionId, 'file_open_error', { requestId, error: 'Not a file.' });
      return;
    }
  } catch {
    await send(sessionId, 'file_open_error', { requestId, error: 'Could not find that file.' });
    return;
  }

  // shell.openPath resolves to '' on success, or a message describing the failure.
  const failure = await shell.openPath(target);
  if (failure) {
    await send(sessionId, 'file_open_error', { requestId, error: failure });
    return;
  }
  await send(sessionId, 'file_opened', {
    requestId,
    path: path.relative(root, target) || path.basename(target),
  });
}

/**
 * Handle a `file_read` / `file_open` session-control message from a paired
 * device. Returns false when the message isn't one of ours, so the caller keeps
 * dispatching.
 */
export function handleRemoteFileControl(message: {
  sessionId: string;
  type: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (message.type !== 'file_read' && message.type !== 'file_open') return false;

  const payload = message.payload ?? {};
  const requestId = String(payload.requestId ?? '');
  if (!requestId) return true;

  if (message.type === 'file_open') {
    void openRemoteFile(message.sessionId, requestId, String(payload.path ?? ''));
  } else {
    void readRemoteFile(message.sessionId, requestId, String(payload.path ?? ''));
  }
  return true;
}
