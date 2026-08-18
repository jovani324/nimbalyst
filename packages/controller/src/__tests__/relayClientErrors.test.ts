// @vitest-environment node
/**
 * Connection-failure reporting.
 *
 * The first live pairing attempt died on `relay refused or unreachable`, which
 * named neither cause. It was in fact a 401: the payload advertised production
 * sync while the host was on a self-hosted relay. These cases pin the two
 * messages apart, because the fix for one is nothing like the fix for the other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayClient, unwrapStoredMessage } from '../relay/relayClient';

class FailingWebSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    setTimeout(() => this.onerror?.(), 0);
  }
  close() {}
}

function connectAgainst(relayUrl: string, reachable: boolean) {
  vi.stubGlobal('WebSocket', FailingWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!reachable) throw new TypeError('Failed to fetch');
      return { type: 'opaque' } as Response;
    })
  );
  return new RelayClient({
    relayUrl,
    orgId: 'organization-live-abc',
    userId: 'member-live-def',
  }).connect();
}

afterEach(() => vi.unstubAllGlobals());

describe('RelayClient connection failures', () => {
  it('points at the Relay URL when something answered', async () => {
    await expect(connectAgainst('wss://sync.nimbalyst.com', true)).rejects.toThrow(
      /answered but refused[\s\S]*correct the Relay URL/i
    );
  });

  it('points at the network when nothing answered', async () => {
    await expect(connectAgainst('wss://relay.example.app', false)).rejects.toThrow(
      /Cannot reach wss:\/\/relay\.example\.app/
    );
  });
});

describe('unwrapStoredMessage', () => {
  // The host encrypts {content, metadata, hidden} AROUND the body, so a client
  // that renders the decrypted string puts a JSON object with a metadata key in
  // the transcript instead of the message.
  it('returns the body, not the envelope', () => {
    const wrapped = JSON.stringify({
      content: '{"type":"assistant","message":{"content":[]}}',
      metadata: { promptOrigin: 'user' },
      hidden: false,
    });
    expect(unwrapStoredMessage(wrapped).content).toBe('{"type":"assistant","message":{"content":[]}}');
  });

  it('carries the hidden flag through', () => {
    expect(unwrapStoredMessage(JSON.stringify({ content: 'x', hidden: true })).hidden).toBe(true);
  });

  it('leaves a body that was never wrapped alone', () => {
    expect(unwrapStoredMessage('{"type":"assistant"}').content).toBe('{"type":"assistant"}');
    expect(unwrapStoredMessage('plain text').content).toBe('plain text');
    expect(unwrapStoredMessage(null).content).toBeNull();
  });
});

/**
 * Compaction reply matching.
 *
 * The reply arrives as a `sessionControlBroadcast` on the shared index room --
 * the same socket every other device's control traffic lands on. Without the
 * requestId check a second controller's rewrite, or a stale reply from a
 * compaction the user already abandoned, would silently replace the draft in
 * this composer.
 */
class ScriptedWebSocket {
  static last: ScriptedWebSocket | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  private listeners = new Set<(event: { data: string }) => void>();
  constructor(_url: string) {
    ScriptedWebSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  addEventListener(_type: string, fn: (event: { data: string }) => void) {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (event: { data: string }) => void) {
    this.listeners.delete(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  /** Deliver a frame the way the relay would. */
  deliver(frame: unknown) {
    const event = { data: JSON.stringify(frame) };
    for (const fn of [...this.listeners]) fn(event);
  }
}

function broadcast(sessionId: string, messageType: string, payload: Record<string, unknown>) {
  return { type: 'sessionControlBroadcast', message: { sessionId, messageType, payload } };
}

/** The requestId the client just put on the wire. */
function sentCompactRequestId(socket: ScriptedWebSocket): string {
  const control = socket.sent.map((raw) => JSON.parse(raw)).find((f) => f.type === 'sessionControl');
  return control.message.payload.requestId;
}

describe('RelayClient.requestCompactedPrompt', () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () => {
    vi.stubGlobal('WebSocket', ScriptedWebSocket);
    return new RelayClient({ relayUrl: 'wss://relay.example.app', orgId: 'org', userId: 'user' });
  };

  it('ignores a reply carrying someone else\'s requestId', async () => {
    const pending = client().requestCompactedPrompt('session-1', 'a long rambling draft');
    await vi.waitFor(() => expect(ScriptedWebSocket.last!.sent.length).toBeGreaterThan(1));
    const socket = ScriptedWebSocket.last!;

    socket.deliver(broadcast('session-1', 'prompt_compacted', { requestId: 'other', text: 'wrong rewrite' }));
    socket.deliver(
      broadcast('session-1', 'prompt_compacted', { requestId: sentCompactRequestId(socket), text: ' fix parser ' })
    );

    await expect(pending).resolves.toBe('fix parser');
  });

  it('surfaces the host\'s error verb as a rejection', async () => {
    const pending = client().requestCompactedPrompt('session-1', 'draft');
    await vi.waitFor(() => expect(ScriptedWebSocket.last!.sent.length).toBeGreaterThan(1));
    const socket = ScriptedWebSocket.last!;

    socket.deliver(
      broadcast('session-1', 'prompt_compact_error', {
        requestId: sentCompactRequestId(socket),
        error: 'The claude CLI is not installed on the host.',
      })
    );

    await expect(pending).rejects.toThrow('The claude CLI is not installed on the host.');
  });
});
