// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';
import type { SessionChange } from '../types';

/**
 * Regression lock for the controller "reply doesn't render" bug.
 *
 * A streamed turn publishes multiple messages whose wire ids are content-hash
 * hex strings (e.g. "cfea159a…", "d9c9099…"). decryptMessage used to coerce the
 * id via parseInt, so any non-numeric id collapsed to 0 — two distinct messages
 * (a thinking chunk and the text-reply chunk) both became id:0 and the consumer's
 * dedup dropped the reply. The decrypted message must carry the full, distinct
 * wire id (as providerMessageId) so dedup keeps them apart.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
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

  receive(message: unknown): void {
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

describe('CollabV3 message dedup id (non-numeric wire ids)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries a distinct providerMessageId for two hex-id chunks of the same turn', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]);
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
      encryptionKey: key,
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    FakeWebSocket.instances[0].open();
    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const socket = FakeWebSocket.instances[1];
    socket.open();
    await connect;

    const changes: SessionChange[] = [];
    provider.onRemoteChange('session-1', (c) => changes.push(c));

    // Two chunks of the same streamed assistant turn, distinct hex wire ids that
    // both parseInt to 0 ('c…' and 'd…'). Push them (which encrypts via the
    // provider's own crypto) and capture the appendMessage wire payloads.
    socket.send.mockClear();
    provider.pushChange('session-1', {
      type: 'message_added',
      message: {
        id: 0,
        providerMessageId: 'cfea159a5c6097ddb31fc4798c727dc4',
        sessionId: 'session-1',
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
        createdAt: new Date(0),
      } as never,
    });
    provider.pushChange('session-1', {
      type: 'message_added',
      message: {
        id: 0,
        providerMessageId: 'd9c9099465f5833f171a013607852cba',
        sessionId: 'session-1',
        source: 'claude-code',
        direction: 'output',
        content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the reply' }] } }),
        createdAt: new Date(0),
      } as never,
    });

    let appended: Array<{ id: string; iv: string; encryptedContent: string }> = [];
    await vi.waitFor(() => {
      appended = socket.send.mock.calls
        .map((c) => JSON.parse(c[0] as string))
        .filter((m) => m.type === 'appendMessage')
        .map((m) => m.message);
      expect(appended).toHaveLength(2);
    });
    // Distinct wire ids survive encryption.
    expect(appended[0].id).not.toBe(appended[1].id);

    // Server relays them back as broadcasts with monotonic sequences.
    appended.forEach((m, i) => socket.receive({ type: 'messageBroadcast', message: { ...m, sequence: i + 1 } }));

    await vi.waitFor(() => {
      const delivered = changes.filter((c) => c.type === 'message_added') as Array<{
        type: 'message_added';
        message: { providerMessageId?: string };
      }>;
      expect(delivered).toHaveLength(2);
      const ids = delivered.map((d) => d.message.providerMessageId);
      // Both distinct and non-empty — so a consumer keyed on providerMessageId
      // won't collapse the reply into the thinking chunk.
      expect(ids[0]).toBeTruthy();
      expect(ids[0]).not.toBe(ids[1]);
    });

    provider.disconnectAll();
  });
});
