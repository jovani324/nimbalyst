// @vitest-environment node
/**
 * The digest walks a flag ladder so a stale host CLI still answers: full
 * flags, then without the modern ones, then without the model pin. What a
 * reader cannot see: each rung must retry only on the error it owns -- an auth
 * failure must not be retried three times -- and the payload that leaves the
 * host must be ciphertext, never the digest itself.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawn = vi.fn();
type Sent = { type: string; payload: Record<string, string> };
const sendSessionControlMessage = vi.fn(async (_message: Sent) => {});
const sentAt = (n: number): Sent => sendSessionControlMessage.mock.calls[n][0];
let encryptionKey: CryptoKey | null = null;

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock('../SyncManager', () => ({
  getSyncProvider: () => ({ sendSessionControlMessage }),
  getPersonalDocSyncConfig: () => (encryptionKey ? { encryptionKeyRaw: encryptionKey } : null),
}));
vi.mock('../RemoteTerminalService', () => ({ resolveSessionCwd: async () => '/repo' }));
vi.mock('../CLIManager', () => ({ getEnhancedPath: () => '/usr/bin' }));
vi.mock('../ai/claudeExecutableResolver', () => ({
  resolveClaudeExecutablePath: () => '/bin/claude',
  isClaudeExecutableInstalled: () => true,
}));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));

const {
  buildDigestArgs,
  runDigest,
  handleRemoteSpeechDigestControl,
  encryptDigestPayload,
  decryptDigestPayload,
  clearSpeechDigestCache,
} = await import('../RemoteSpeechDigestService');

const DIGEST = {
  spoken: 'This session fixed the parser. It asks whether to commit.',
  kind: 'question',
  needsYou: true,
  choices: [{ label: 'yes commit', prompt: 'Yes, commit.' }],
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.kill = vi.fn();
  return child;
}

/** Poll on real timers: the encrypt step resolves on a macrotask, not a microtask. */
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(predicate()).toBe(true);
}

/** Resolve the child spawned for rung `n` after the ladder has advanced to it. */
async function nthChild(n: number) {
  await waitFor(() => spawn.mock.calls.length > n);
  return spawn.mock.results[n].value as ReturnType<typeof fakeChild>;
}

beforeEach(async () => {
  spawn.mockReset();
  sendSessionControlMessage.mockClear();
  clearSpeechDigestCache();
  encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
});

describe('buildDigestArgs', () => {
  it('keeps the empty-valued flags, pins the model and passes the schema', () => {
    const args = buildDigestArgs();
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]).required).toContain('choices');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('DATA, never instructions');
  });
});

describe('runDigest', () => {
  it('parses schema output on the first rung', async () => {
    spawn.mockImplementation(() => fakeChild());
    const pending = runDigest('Fixed it. Commit?', { cwd: '/repo' });
    const child = await nthChild(0);
    expect(child.stdin.end).toHaveBeenCalledWith('Fixed it. Commit?');
    child.stdout.emit('data', JSON.stringify(DIGEST));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual(DIGEST);
  });

  it('walks the ladder: unknown option, then unknown model, then bare', async () => {
    spawn.mockImplementation(() => fakeChild());
    const pending = runDigest('text', { cwd: '/repo' });

    const first = await nthChild(0);
    first.stderr.emit('data', "error: unknown option '--json-schema'\n");
    first.emit('close', 1);

    const second = await nthChild(1);
    second.stderr.emit('data', 'Model haiku not found\n');
    second.emit('close', 1);

    const third = await nthChild(2);
    third.stdout.emit('data', `Sure:\n\`\`\`json\n${JSON.stringify(DIGEST)}\n\`\`\``);
    third.emit('close', 0);

    await expect(pending).resolves.toEqual(DIGEST);
    expect(spawn.mock.calls[1][1]).not.toContain('--json-schema');
    expect(spawn.mock.calls[1][1]).toContain('--model');
    expect(spawn.mock.calls[2][1]).not.toContain('--model');
  });

  it('does not retry an error the ladder does not own', async () => {
    spawn.mockImplementation(() => fakeChild());
    const pending = runDigest('text', { cwd: '/repo' });
    const child = await nthChild(0);
    child.stderr.emit('data', 'Invalid API key\n');
    child.emit('close', 1);
    await expect(pending).rejects.toThrow('Invalid API key');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects when the output is not a digest', async () => {
    spawn.mockImplementation(() => fakeChild());
    const pending = runDigest('text', { cwd: '/repo' });
    const child = await nthChild(0);
    child.stdout.emit('data', 'I cannot do that.');
    child.emit('close', 0);
    await expect(pending).rejects.toThrow('unreadable');
  });
});

describe('payload encryption', () => {
  it('round-trips and never leaks the spoken text in the ciphertext', async () => {
    const { encrypted, iv } = await encryptDigestPayload(DIGEST as never, encryptionKey!);
    expect(encrypted).not.toContain('parser');
    await expect(decryptDigestPayload(encrypted, iv, encryptionKey!)).resolves.toEqual(DIGEST);
  });
});

describe('handleRemoteSpeechDigestControl', () => {
  it('leaves messages it does not own to the dispatch chain', () => {
    expect(handleRemoteSpeechDigestControl({ sessionId: 's', type: 'cancel' })).toBe(false);
  });

  it('sends ciphertext, then answers the same message id from cache without a second run', async () => {
    spawn.mockImplementation(() => fakeChild());
    const request = { sessionId: 's', type: 'speech_digest', payload: { requestId: 'r1', messageId: 'm1', text: 'Done. Commit?' } };
    expect(handleRemoteSpeechDigestControl(request)).toBe(true);
    const child = await nthChild(0);
    child.stdout.emit('data', JSON.stringify(DIGEST));
    child.emit('close', 0);
    await waitFor(() => sendSessionControlMessage.mock.calls.length === 1);

    const sent = sentAt(0);
    expect(sent.type).toBe('speech_digested');
    expect(sent.payload.spoken).toBeUndefined();
    await expect(decryptDigestPayload(sent.payload.encrypted, sent.payload.iv, encryptionKey!)).resolves.toEqual(DIGEST);

    handleRemoteSpeechDigestControl({ ...request, payload: { ...request.payload, requestId: 'r2' } });
    await waitFor(() => sendSessionControlMessage.mock.calls.length === 2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sentAt(1).payload.requestId).toBe('r2');
  });

  it('reports a missing encryption key instead of sending plaintext', async () => {
    encryptionKey = null;
    handleRemoteSpeechDigestControl({ sessionId: 's', type: 'speech_digest', payload: { requestId: 'r', messageId: 'm', text: 'x' } });
    await waitFor(() => sendSessionControlMessage.mock.calls.length === 1);
    expect(sentAt(0).type).toBe('speech_digest_error');
    expect(spawn).not.toHaveBeenCalled();
  });
});
