/**
 * RemoteTerminalService — a shell on the HOST, driven from a paired device.
 *
 * The controller runs on a different machine, so "open a terminal" means: spawn
 * a PTY here, in the session's own working directory, and relay its bytes over
 * the same session-control channel that carries prompts and prompt responses.
 *
 * This is deliberately NOT the desktop's TerminalSessionManager. That one owns
 * scrollback persistence, per-workspace stores, shell-history bootstrapping and
 * renderer broadcasts — all of which belong to a terminal a human is looking at
 * on this machine. A controller terminal is ephemeral: it exists while the
 * remote pane is open, dies with it, and leaves nothing behind.
 *
 * Trust: any device that can send session-control messages is already paired and
 * can queue prompts to an agent that runs arbitrary tools, so this is not a new
 * boundary — but it is a direct one, and `sessionSync.remoteTerminalEnabled`
 * turns it off outright.
 */

import type { IPty } from 'node-pty';
import { app } from 'electron';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getSyncProvider } from './SyncManager';
import { isRemoteTerminalEnabled } from '../utils/store';
import { getEnhancedPath } from './CLIManager';
import { ShellDetector } from './ShellDetector';
import { logger } from '../utils/logger';

const log = logger.main;

// Same asar caveat as TerminalSessionManager: the resolved path must not contain
// "app.asar", or node-pty's own replace() mangles it into ".unpacked.unpacked".
function loadNodePty(): typeof import('node-pty') {
  const require = createRequire(import.meta.url);
  return app.isPackaged ? require(path.join(process.resourcesPath, 'node-pty')) : require('node-pty');
}

/** Output is coalesced into one message per tick rather than per PTY chunk. */
const FLUSH_INTERVAL_MS = 60;
/** Beyond this a single relay message gets unwieldy; flush early instead. */
const MAX_CHUNK_BYTES = 8 * 1024;
/** A remote terminal nobody has typed into for this long is abandoned. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Guard against a buggy or hostile client opening shells without bound. */
const MAX_TERMINALS = 4;

interface RemoteTerminal {
  pty: IPty;
  sessionId: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout>;
}

const terminals = new Map<string, RemoteTerminal>();

/**
 * Worktree sessions keep the parent project as `workspacePath`, so a terminal
 * opened on one has to land in the worktree or every command it runs is against
 * the wrong checkout.
 */
export async function resolveSessionCwd(sessionId: string): Promise<string> {
  try {
    const session = (await AISessionsRepository.get(sessionId)) as
      | { workspacePath?: string | null; worktreeId?: string | null; worktreePath?: string | null }
      | null;
    const candidate =
      (session?.worktreeId && session?.worktreePath ? session.worktreePath : session?.workspacePath) ?? '';
    if (candidate && existsSync(candidate)) return candidate;
  } catch (err) {
    log.warn('[RemoteTerminalService] Could not resolve session cwd:', err);
  }
  return os.homedir();
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
    log.warn('[RemoteTerminalService] Failed to relay terminal message:', err);
  }
}

function flush(terminalId: string): void {
  const term = terminals.get(terminalId);
  if (!term) return;
  if (term.flushTimer) {
    clearTimeout(term.flushTimer);
    term.flushTimer = null;
  }
  if (!term.pending) return;
  const data = term.pending;
  term.pending = '';
  void send(term.sessionId, 'terminal_output', { terminalId, data });
}

function queueOutput(terminalId: string, data: string): void {
  const term = terminals.get(terminalId);
  if (!term) return;
  term.pending += data;
  if (term.pending.length >= MAX_CHUNK_BYTES) {
    flush(terminalId);
    return;
  }
  if (!term.flushTimer) {
    term.flushTimer = setTimeout(() => flush(terminalId), FLUSH_INTERVAL_MS);
  }
}

function touch(terminalId: string): void {
  const term = terminals.get(terminalId);
  if (!term) return;
  clearTimeout(term.idleTimer);
  term.idleTimer = setTimeout(() => closeRemoteTerminal(terminalId, 'idle'), IDLE_TIMEOUT_MS);
}

/** Kill a remote terminal and tell the requesting device it is gone. */
export function closeRemoteTerminal(terminalId: string, reason: 'closed' | 'idle' = 'closed'): void {
  const term = terminals.get(terminalId);
  if (!term) return;
  flush(terminalId);
  clearTimeout(term.idleTimer);
  terminals.delete(terminalId);
  try {
    term.pty.kill();
  } catch {
    /* already dead */
  }
  void send(term.sessionId, 'terminal_exit', { terminalId, reason });
}

/** Kill every remote terminal (host shutdown, sync teardown). */
export function closeAllRemoteTerminals(): void {
  for (const terminalId of [...terminals.keys()]) closeRemoteTerminal(terminalId);
}

async function openRemoteTerminal(
  sessionId: string,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (terminals.has(terminalId)) return;
  if (terminals.size >= MAX_TERMINALS) {
    await send(sessionId, 'terminal_error', {
      terminalId,
      error: `Too many open terminals on the host (${MAX_TERMINALS}).`,
    });
    return;
  }

  const cwd = await resolveSessionCwd(sessionId);
  const shell = ShellDetector.getDefaultShell();

  let ptyProcess: IPty;
  try {
    const pty = loadNodePty();
    ptyProcess = pty.spawn(shell.path, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(cols || 80, 400)),
      rows: Math.max(5, Math.min(rows || 24, 200)),
      cwd,
      env: { ...process.env, PATH: getEnhancedPath(), TERM: 'xterm-256color' } as Record<string, string>,
    });
  } catch (err) {
    await send(sessionId, 'terminal_error', {
      terminalId,
      error: err instanceof Error ? err.message : 'Failed to start a shell',
    });
    return;
  }

  const term: RemoteTerminal = {
    pty: ptyProcess,
    sessionId,
    pending: '',
    flushTimer: null,
    idleTimer: setTimeout(() => closeRemoteTerminal(terminalId, 'idle'), IDLE_TIMEOUT_MS),
  };
  terminals.set(terminalId, term);

  ptyProcess.onData((data) => queueOutput(terminalId, data));
  ptyProcess.onExit(({ exitCode }) => {
    const existing = terminals.get(terminalId);
    if (!existing) return;
    flush(terminalId);
    clearTimeout(existing.idleTimer);
    terminals.delete(terminalId);
    void send(sessionId, 'terminal_exit', { terminalId, exitCode });
  });

  log.info('[RemoteTerminalService] Opened remote terminal', { sessionId, terminalId, cwd });
  await send(sessionId, 'terminal_ready', { terminalId, cwd, shell: shell.name });
}

/**
 * Handle a `terminal_*` session-control message from a paired device. Returns
 * false when the message isn't one of ours, so the caller can keep dispatching.
 */
export function handleRemoteTerminalControl(message: {
  sessionId: string;
  type: string;
  payload?: Record<string, unknown>;
}): boolean {
  if (!message.type.startsWith('terminal_')) return false;

  if (!isRemoteTerminalEnabled()) {
    const terminalId = String(message.payload?.terminalId ?? '');
    void send(message.sessionId, 'terminal_error', {
      terminalId,
      error: 'Remote terminals are turned off on the host.',
    });
    return true;
  }

  const payload = message.payload ?? {};
  const terminalId = String(payload.terminalId ?? '');
  if (!terminalId) return true;

  switch (message.type) {
    case 'terminal_open':
      void openRemoteTerminal(
        message.sessionId,
        terminalId,
        Number(payload.cols) || 80,
        Number(payload.rows) || 24,
      );
      return true;

    case 'terminal_input': {
      const term = terminals.get(terminalId);
      if (!term) return true;
      touch(terminalId);
      try {
        term.pty.write(String(payload.data ?? ''));
      } catch (err) {
        log.warn('[RemoteTerminalService] Write failed:', err);
      }
      return true;
    }

    case 'terminal_resize': {
      const term = terminals.get(terminalId);
      if (!term) return true;
      try {
        term.pty.resize(
          Math.max(20, Math.min(Number(payload.cols) || 80, 400)),
          Math.max(5, Math.min(Number(payload.rows) || 24, 200)),
        );
      } catch {
        /* a resize on a dying pty is not worth reporting */
      }
      return true;
    }

    case 'terminal_close':
      closeRemoteTerminal(terminalId);
      return true;

    default:
      // terminal_output / terminal_exit are our own echoes coming back; ignore.
      return true;
  }
}
