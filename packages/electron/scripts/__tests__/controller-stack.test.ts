/**
 * Regression tests for controller-stack.sh.
 *
 * The bug these pin down: `stop` killed only the wrapper process and left the
 * real tree (npm -> electron-vite -> Electron) running, then deleted the
 * pidfile — so `status` cheerfully reported everything stopped while both apps
 * and the relay were still alive and holding their ports.
 *
 * The relay slot is used as the harness because RELAY_DIR is an env override,
 * so a fake `server.mjs` can stand in for the real relay without launching npm
 * or Electron. Every command is scoped to `relay` so a full-stack sweep can
 * never reach a developer's real `npm run dev`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../controller-stack.sh');

let tmpDir: string;
let relayDir: string;
let logDir: string;
let grandchildPidFile: string;
let relayPort: number;

/**
 * Stands in for the relay. It listens on the port (so the port-based leftover
 * check has something to find) and spawns a grandchild that outlives a naive
 * single-pid kill — the thing that used to survive `stop`.
 */
const FAKE_RELAY = `
import net from 'net';
import fs from 'fs';
import { spawn } from 'child_process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));

net.createServer().listen(Number(process.env.RELAY_TEST_PORT));
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function run(
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // The suite itself may be running over SSH; the fake relay does not need
      // a Keychain, so opt past the GUI-session guard unless a test is
      // exercising it.
      ALLOW_HEADLESS_START: '1',
      RELAY_DIR: relayDir,
      CONTROLLER_LOG_DIR: logDir,
      SYNC_URL: `ws://localhost:${relayPort}`,
      // Keep the graceful-quit wait short; the real default is 15s.
      GRACE_SECONDS: '2',
      RELAY_TEST_PORT: String(relayPort),
      GRANDCHILD_PID_FILE: grandchildPidFile,
      ...extraEnv,
    },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

function readPid(file: string): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function hasLsof(): boolean {
  return spawnSync('which', ['lsof'], { encoding: 'utf8' }).status === 0;
}

describe('controller-stack.sh', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-stack-'));
    relayDir = path.join(tmpDir, 'private-sync-relay');
    logDir = path.join(tmpDir, 'logs');
    grandchildPidFile = path.join(tmpDir, 'grandchild.pid');
    fs.mkdirSync(relayDir, { recursive: true });
    // `start` runs `npm install` when node_modules is absent; give it one.
    fs.mkdirSync(path.join(relayDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(relayDir, 'server.mjs'), FAKE_RELAY);
    // Random high port so concurrent test files do not collide.
    relayPort = 20000 + Math.floor(Math.random() * 20000);
  });

  afterEach(() => {
    // Never leak processes out of a test run, whatever the assertions did.
    for (const file of [path.join(logDir, 'pids', 'relay.pid'), grandchildPidFile]) {
      const pid = readPid(file);
      if (pid && isAlive(pid)) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stop kills the whole process tree, not just the wrapper', async () => {
    const started = run(['start', 'relay']);
    expect(started.status).toBe(0);

    const relayPid = readPid(path.join(logDir, 'pids', 'relay.pid'));
    expect(relayPid).toBeGreaterThan(0);

    // Wait for the fake relay to spawn its grandchild.
    expect(await waitFor(() => readPid(grandchildPidFile) !== null)).toBe(true);
    const grandchildPid = readPid(grandchildPidFile)!;
    expect(isAlive(relayPid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const stopped = run(['stop', 'relay']);
    expect(stopped.status).toBe(0);

    // The regression: the grandchild used to survive this.
    expect(await waitFor(() => !isAlive(relayPid!))).toBe(true);
    expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);

    // A confirmed stop clears the pidfile.
    expect(fs.existsSync(path.join(logDir, 'pids', 'relay.pid'))).toBe(false);
  });

  it('refuses to start over SSH, where Electron cannot reach the Keychain', () => {
    // Started without a GUI session, safeStorage cannot decrypt the Stytch
    // credentials and both instances come up silently signed out.
    const res = run(['start', 'relay'], {
      SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22',
      ALLOW_HEADLESS_START: '0',
    });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('refusing to start over SSH');
    // Nothing may be launched when it refuses.
    expect(fs.existsSync(path.join(logDir, 'pids', 'relay.pid'))).toBe(false);
  });

  it('status reports a survivor instead of claiming a clean stop', async () => {
    expect(run(['start', 'relay']).status).toBe(0);
    const pidFile = path.join(logDir, 'pids', 'relay.pid');
    const relayPid = readPid(pidFile);
    expect(relayPid).toBeGreaterThan(0);
    expect(await waitFor(() => readPid(grandchildPidFile) !== null)).toBe(true);

    if (!hasLsof()) {
      // Port-based detection needs lsof; the tree-kill test above still covers
      // the core defect without it.
      return;
    }

    // Reproduce the old failure mode: the pidfile is gone but the process is
    // not. Status must not call that "stopped" and leave it at that.
    fs.rmSync(pidFile);
    const status = run(['status']);

    expect(status.stdout).toContain('unmanaged processes from this checkout');
    expect(status.stdout).toContain(String(relayPid));
  });
});
