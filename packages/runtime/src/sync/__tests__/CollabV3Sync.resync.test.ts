// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * Regression lock for controller-mode transcript catch-up.
 *
 * Session sockets do NOT auto-reconnect on an unexpected drop the way the index
 * socket does, so a viewer (the controller popover) would silently stop seeing
 * live messages until the next manual connect(). `provider.resync()` is the
 * in-place catch-up the viewer polls: it requests everything after the last-seen
 * sequence on a live socket, and reports back (via a boolean) when the socket has
 * dropped so the CALLER reconnects through its own path and re-registers its
 * transcript listener.
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

  /** Simulate an abnormal server-side drop (no clean close frame). */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function makeProvider() {
  return createCollabV3Sync({
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    userId: 'user-1',
    getJwt: async () => jwtFor('user-1'),
  });
}

/** Bring a session room to an OPEN socket and return that socket. */
async function connectSession(
  provider: ReturnType<typeof createCollabV3Sync>,
  sessionId: string,
): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
  FakeWebSocket.instances[0].open(); // index socket
  const connect = provider.connect(sessionId);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  const sessionSocket = FakeWebSocket.instances[1];
  sessionSocket.open();
  await connect;
  return sessionSocket;
}

describe('CollabV3 resync (controller catch-up)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests messages since the last-seen sequence on an open socket and reports caught-up', async () => {
    const provider = makeProvider();
    const socket = await connectSession(provider, 'session-1');
    socket.send.mockClear(); // drop the initial onopen full sync

    const caughtUp = await provider.resync!('session-1');

    expect(caughtUp).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0][0] as string);
    expect(sent).toMatchObject({ type: 'syncRequest', sinceSeq: 0 });

    provider.disconnectAll();
  });

  it('reports not-caught-up after an unexpected socket drop so the caller reconnects', async () => {
    const provider = makeProvider();
    const socket = await connectSession(provider, 'session-1');

    socket.drop(); // session sockets do not auto-reconnect
    expect(provider.isConnected('session-1')).toBe(false);

    const caughtUp = await provider.resync!('session-1');

    expect(caughtUp).toBe(false);
    // resync must NOT create a fresh socket itself — the service owns reconnection
    // so its transcript listener is re-registered on the new session object.
    expect(FakeWebSocket.instances).toHaveLength(2);

    provider.disconnectAll();
  });

  it('leaves a still-connecting socket alone (its own open handler sends the sync)', async () => {
    const provider = makeProvider();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    FakeWebSocket.instances[0].open();
    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const socket = FakeWebSocket.instances[1]; // never opened -> stays CONNECTING

    const caughtUp = await provider.resync!('session-1');

    expect(caughtUp).toBe(true);
    expect(socket.send).not.toHaveBeenCalled();

    socket.open();
    await connect;
    provider.disconnectAll();
  });
});
