// @vitest-environment node
/**
 * Compaction is a request/response over the SHARED session-control channel:
 * terminal bytes, file reads and every other device's traffic land on the same
 * callback. Matching on requestId is the only thing keeping a stale or foreign
 * rewrite from replacing the draft the user is typing, and nothing on screen
 * would show that it had.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

type ControlMessage = { sessionId: string; type: string; payload?: Record<string, unknown>; sentBy: string };

const sent: ControlMessage[] = [];
let deliver: (message: ControlMessage) => void = () => {};
let encryptionKey: CryptoKey | null = null;

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/store', () => ({ isControllerMode: () => true }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../SyncManager', () => ({
  getPersonalDocSyncConfig: () => (encryptionKey ? { encryptionKeyRaw: encryptionKey } : null),
  getSyncProvider: () => ({
    sendSessionControlMessage: async (message: ControlMessage) => {
      sent.push(message);
    },
    onSessionControlMessage: (callback: (message: ControlMessage) => void) => {
      deliver = callback;
      return () => {};
    },
  }),
}));

const { compactRemotePrompt, requestRemoteSpeechDigest } = await import('../RemoteSessionService');
const { encryptDigestPayload } = await import('../RemoteSpeechDigestService');

/** The requestId the service just put on the wire. */
const lastRequestId = () => String(sent[sent.length - 1].payload!.requestId);

beforeEach(() => {
  sent.length = 0;
});

describe('compactRemotePrompt', () => {
  it('ignores a reply carrying another request\'s id', async () => {
    const pending = compactRemotePrompt('session-1', 'a long rambling draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'prompt_compact', sentBy: 'mobile' });

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: 'someone-else', text: 'wrong rewrite' },
    });
    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), text: '  fix parser  ' },
    });

    await expect(pending).resolves.toEqual({ success: true, text: 'fix parser' });
  });

  it('reports the host\'s own error rather than a generic failure', async () => {
    const pending = compactRemotePrompt('session-1', 'draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compact_error',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), error: 'The claude CLI is not installed on the host.' },
    });

    await expect(pending).resolves.toEqual({
      success: false,
      error: 'The claude CLI is not installed on the host.',
    });
  });

  it('treats an empty rewrite as a failure, so the draft is never wiped', async () => {
    const pending = compactRemotePrompt('session-1', 'draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), text: '   ' },
    });

    await expect(pending).resolves.toMatchObject({ success: false });
  });
});

describe('requestRemoteSpeechDigest', () => {
  const DIGEST = { spoken: 'Done. Commit?', kind: 'question', needsYou: true, choices: [{ label: 'yes', prompt: 'Yes.' }] };

  beforeEach(async () => {
    encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  });

  it('decrypts the matching reply and ignores a foreign request id', async () => {
    const pending = requestRemoteSpeechDigest('session-1', 'm1', 'Done. Commit?');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'speech_digest', payload: { messageId: 'm1' } });

    const cipher = await encryptDigestPayload(DIGEST as never, encryptionKey!);
    deliver({ sessionId: 'session-1', type: 'speech_digested', sentBy: 'desktop', payload: { requestId: 'other', messageId: 'm1', ...cipher } });
    deliver({ sessionId: 'session-1', type: 'speech_digested', sentBy: 'desktop', payload: { requestId: lastRequestId(), messageId: 'm1', ...cipher } });

    await expect(pending).resolves.toEqual({ success: true, messageId: 'm1', digest: DIGEST });
  });

  it('fails closed when the payload is plaintext or the key is missing', async () => {
    const pending = requestRemoteSpeechDigest('session-1', 'm1', 'x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    deliver({ sessionId: 'session-1', type: 'speech_digested', sentBy: 'desktop', payload: { requestId: lastRequestId(), messageId: 'm1', digest: DIGEST } });
    await expect(pending).resolves.toMatchObject({ success: false, error: 'The digest could not be decrypted.' });

    encryptionKey = null;
    const second = requestRemoteSpeechDigest('session-1', 'm2', 'x');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    deliver({ sessionId: 'session-1', type: 'speech_digested', sentBy: 'desktop', payload: { requestId: lastRequestId(), messageId: 'm2', encrypted: 'a', iv: 'b' } });
    await expect(second).resolves.toMatchObject({ success: false, messageId: 'm2' });
  });

  it('reports the host error', async () => {
    const pending = requestRemoteSpeechDigest('session-1', 'm1', 'x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    deliver({ sessionId: 'session-1', type: 'speech_digest_error', sentBy: 'desktop', payload: { requestId: lastRequestId(), messageId: 'm1', error: 'Nothing to say.' } });
    await expect(pending).resolves.toEqual({ success: false, messageId: 'm1', error: 'Nothing to say.' });
  });
});
