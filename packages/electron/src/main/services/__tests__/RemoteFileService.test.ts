// @vitest-environment node
/**
 * The controller can ask the host to read any path it names, so the only thing
 * standing between a paired device and the host's whole disk is resolveInsideRoot.
 * `..` and a symlink out of the checkout are the two ways that fails.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../RemoteTerminalService', () => ({ resolveSessionCwd: async () => '/unused' }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));

const { resolveInsideRoot } = await import('../RemoteFileService');

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'remote-file-'));
  root = path.join(base, 'repo');
  outside = path.join(base, 'secrets');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(outside, 'keys.txt'), 'sensitive\n');
  await symlink(path.join(outside, 'keys.txt'), path.join(root, 'escape.txt'));
});

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe('resolveInsideRoot', () => {
  it('resolves a relative path inside the session folder', async () => {
    await expect(resolveInsideRoot(root, 'src/a.ts')).resolves.toContain(path.join('src', 'a.ts'));
  });

  it('refuses a path that climbs out with ..', async () => {
    await expect(resolveInsideRoot(root, '../secrets/keys.txt')).resolves.toBeNull();
  });

  it('refuses an absolute path outside the session folder', async () => {
    await expect(resolveInsideRoot(root, path.join(outside, 'keys.txt'))).resolves.toBeNull();
  });

  it('refuses a symlink that points out of the session folder', async () => {
    await expect(resolveInsideRoot(root, 'escape.txt')).resolves.toBeNull();
  });

  it('refuses a missing file rather than guessing', async () => {
    await expect(resolveInsideRoot(root, 'src/nope.ts')).resolves.toBeNull();
  });
});
