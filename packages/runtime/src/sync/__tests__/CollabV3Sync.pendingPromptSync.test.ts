// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';
import type { SessionChange } from '../types';

/**
 * Regression lock for the controller/mobile "approve a tool permission remotely"
 * path. SDK sessions never write the permission into the transcript — the host
 * syncs the full payload inside the encrypted ClientMetadata instead. This test
 * does a real roundtrip through the provider's OWN crypto: push a metadata_updated
 * carrying `pendingPromptData`, capture the `updateMetadata` the provider actually
 * sends, feed that exact encrypted blob back as a `metadataBroadcast`, and assert
 * the receiver decodes `pendingPromptData` intact.
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
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true } as CloseEvent);
  });

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

const PENDING = {
  promptType: 'permission_request' as const,
  requestId: 'tool-perm-abc-123',
  toolName: 'Bash',
  rawCommand: 'rm -rf build',
  pattern: 'Bash(rm:*)',
  patternDisplayName: 'rm commands',
  isDestructive: true,
  warnings: ['deletes files'],
};

describe('CollabV3 pendingPromptData sync (remote approve)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips the pending-permission payload through encrypted ClientMetadata', async () => {
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

    // Open index + session sockets.
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    FakeWebSocket.instances[0].open();
    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const sessionSocket = FakeWebSocket.instances[1];
    sessionSocket.open();
    await connect;

    const changes: SessionChange[] = [];
    provider.onRemoteChange('session-1', (c) => changes.push(c));

    // Host side: push the pending-permission payload.
    sessionSocket.send.mockClear();
    provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { hasPendingPrompt: true, pendingPromptData: PENDING, updatedAt: 1 } as never,
    });

    // Capture the updateMetadata the provider actually sent (with its own encryption).
    let sentMetadata: { encryptedClientMetadata?: string; clientMetadataIv?: string } | undefined;
    await vi.waitFor(() => {
      const call = sessionSocket.send.mock.calls
        .map((c) => JSON.parse(c[0] as string))
        .find((m) => m.type === 'updateMetadata');
      expect(call).toBeTruthy();
      sentMetadata = call.metadata;
      expect(sentMetadata?.encryptedClientMetadata).toBeTruthy();
    });

    // Receiver side: the server relays it back as a metadataBroadcast.
    sessionSocket.receive({ type: 'metadataBroadcast', metadata: sentMetadata });

    await vi.waitFor(() => {
      const md = changes.find((c) => c.type === 'metadata_updated') as
        | { type: 'metadata_updated'; metadata: { pendingPromptData?: typeof PENDING } }
        | undefined;
      expect(md?.metadata.pendingPromptData).toEqual(PENDING);
    });

    provider.disconnectAll();
  });

  it('clears the payload (null) on resolve', async () => {
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
    const sessionSocket = FakeWebSocket.instances[1];
    sessionSocket.open();
    await connect;

    const changes: SessionChange[] = [];
    provider.onRemoteChange('session-1', (c) => changes.push(c));

    sessionSocket.send.mockClear();
    provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { hasPendingPrompt: false, pendingPromptData: null, updatedAt: 2 } as never,
    });

    let sentMetadata: unknown;
    await vi.waitFor(() => {
      const call = sessionSocket.send.mock.calls
        .map((c) => JSON.parse(c[0] as string))
        .find((m) => m.type === 'updateMetadata');
      expect(call?.metadata?.encryptedClientMetadata).toBeTruthy();
      sentMetadata = call.metadata;
    });
    sessionSocket.receive({ type: 'metadataBroadcast', metadata: sentMetadata });

    await vi.waitFor(() => {
      const md = changes.find((c) => c.type === 'metadata_updated') as
        | { type: 'metadata_updated'; metadata: { pendingPromptData?: unknown } }
        | undefined;
      expect(md?.metadata.pendingPromptData).toBeNull();
    });

    provider.disconnectAll();
  });
});
