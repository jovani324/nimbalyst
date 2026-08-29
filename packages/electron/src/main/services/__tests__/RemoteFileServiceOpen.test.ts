// @vitest-environment node
/**
 * Opening a picture resolves the file the host actually holds. A repo image
 * comes straight from the session folder (resolveInsideRoot, tested elsewhere);
 * a pasted attachment is trickier — the transcript shows a bare `@name.png`, but
 * on disk it is `<stagingRoot>/saved/<sessionId>/<timestamp>_<name>`, so the
 * resolver has to match the timestamp-prefixed name and stay inside that folder.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const WORKSPACE = '/workspace/project';
let stagingRoot: string;

vi.mock('../SyncManager', () => ({ getSyncProvider: () => null }));
vi.mock('../RemoteTerminalService', () => ({ resolveSessionCwd: async () => '/unused' }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { get: async () => ({ workspacePath: WORKSPACE }) },
}));
vi.mock('../attachments/attachmentStagingRoot', () => ({
  resolveWorkspaceAttachmentStagingDirectory: () => stagingRoot,
  resolveSavedAttachmentDirectory: (dir: string) => path.join(dir, 'saved'),
}));

const { resolveStagedAttachment } = await import('../RemoteFileService');

const SESSION = 'sess-1';
let savedSessionDir: string;

beforeAll(async () => {
  stagingRoot = await mkdtemp(path.join(tmpdir(), 'remote-open-'));
  savedSessionDir = path.join(stagingRoot, 'saved', SESSION);
  await mkdir(savedSessionDir, { recursive: true });
  // Two staged copies of the same name across turns; the newer one wins.
  await writeFile(path.join(savedSessionDir, '111_shot.png'), 'old');
  await writeFile(path.join(savedSessionDir, '222_shot.png'), 'new');
  await utimes(path.join(savedSessionDir, '111_shot.png'), new Date(1000), new Date(1000));
  await utimes(path.join(savedSessionDir, '222_shot.png'), new Date(2000), new Date(2000));
  await writeFile(path.join(savedSessionDir, 'exact.png'), 'x');
});

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true });
});

describe('resolveStagedAttachment', () => {
  // realpath resolves symlinked temp roots (e.g. /var -> /private/var on macOS),
  // so assert on the tail rather than an exact absolute path.
  const tail = (name: string) => path.join('saved', SESSION, name);

  it('finds the newest staged copy of a bare @name reference', async () => {
    const hit = await resolveStagedAttachment(SESSION, 'shot.png');
    expect(hit?.endsWith(tail('222_shot.png'))).toBe(true);
  });

  it('matches a name saved without a timestamp prefix', async () => {
    const hit = await resolveStagedAttachment(SESSION, 'exact.png');
    expect(hit?.endsWith(tail('exact.png'))).toBe(true);
  });

  it('refuses a reference that carries a directory (that is a repo path, not a mention)', async () => {
    await expect(resolveStagedAttachment(SESSION, 'sub/shot.png')).resolves.toBeNull();
  });

  it('returns null when no staged file matches', async () => {
    await expect(resolveStagedAttachment(SESSION, 'missing.png')).resolves.toBeNull();
  });
});
