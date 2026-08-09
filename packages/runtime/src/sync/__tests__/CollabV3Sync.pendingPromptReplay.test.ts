// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';
import type { SessionChange } from '../types';

/**
 * Regression lock: an interactive prompt raised BEFORE a remote device joined
 * the session room must still reach it.
 *
 * The host only sends `updateMetadata` to rooms it is currently connected to, so
 * a question asked while the controller was looking elsewhere exists only in the
 * room's stored metadata. That arrives on `sync_response` at connect time — and
 * used to be cached and nothing more, so the controller opened the session,
 * saw a stalled agent, and had no way to answer it.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Encrypt a client-metadata blob exactly the way the host does (AES-GCM, base64). */
async function encryptClientMetadata(metadata: unknown, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(metadata)),
  );
  return {
    encryptedClientMetadata: toBase64(new Uint8Array(encrypted)),
    clientMetadataIv: toBase64(iv),
  };
}

const QUESTION = {
  promptType: 'ask_user_question' as const,
  questionId: 'q-1',
  questions: [
    {
      question: 'Which approach?',
      header: 'Approach',
      options: [{ label: 'A', description: 'first' }],
      multiSelect: false,
    },
  ],
};

describe('CollabV3 sync_response pending-prompt replay', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function connected() {
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
      encryptionKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    FakeWebSocket.instances[0].open(); // index socket
    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const socket = FakeWebSocket.instances[1];
    socket.open();
    await connect;

    const changes: SessionChange[] = [];
    provider.onRemoteChange('session-1', (change) => changes.push(change));
    return { provider, socket, encryptionKey, changes };
  }

  it('emits a prompt that was already open when the device connected', async () => {
    const { provider, socket, encryptionKey, changes } = await connected();

    socket.deliver({
      type: 'syncResponse',
      messages: [],
      hasMore: false,
      cursor: null,
      metadata: {
        provider: 'claude-code',
        ...(await encryptClientMetadata({ hasPendingPrompt: true, pendingPromptData: QUESTION }, encryptionKey)),
      },
    });

    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toEqual({
      type: 'metadata_updated',
      metadata: { hasPendingPrompt: true, pendingPromptData: QUESTION },
    });

    provider.disconnectAll();
  });

  it('stays quiet when the room carries no prompt state', async () => {
    const { provider, socket, encryptionKey, changes } = await connected();

    socket.deliver({
      type: 'syncResponse',
      messages: [],
      hasMore: false,
      cursor: null,
      metadata: {
        provider: 'claude-code',
        ...(await encryptClientMetadata({ phase: 'implementing' }, encryptionKey)),
      },
    });

    // Give the async decrypt a chance to run before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(changes).toHaveLength(0);

    provider.disconnectAll();
  });
});
