// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * Regression lock for the controller "reply was never sent" hang.
 *
 * `fetchIndex()` shares a single `pendingIndexFetch` slot. Two overlapping calls
 * (the popover's auto-load racing a manual refresh, or a StrictMode remount) used
 * to clobber that slot: one request's server response resolved the OTHER call's
 * promise, and the orphaned promise's 30s timeout — guarded on the now-null slot —
 * never fired. That promise never settled, so the `remote-sessions:list` invoke
 * hung forever and Electron surfaced "reply was never sent".
 *
 * The fix coalesces concurrent callers onto one in-flight request. This test locks
 * both halves of that contract: exactly ONE `indexSyncRequest` on the wire, and
 * BOTH callers settle from a single server response (neither is orphaned).
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

  /** Deliver a server frame to this socket's message handler. */
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

function makeProvider() {
  return createCollabV3Sync({
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    userId: 'user-1',
    getJwt: async () => jwtFor('user-1'),
  });
}

function indexSyncRequestCount(socket: FakeWebSocket): number {
  return socket.send.mock.calls.filter((call) => {
    try {
      return JSON.parse(call[0] as string)?.type === 'indexSyncRequest';
    } catch {
      return false;
    }
  }).length;
}

describe('CollabV3 fetchIndex single-flight', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coalesces two concurrent fetchIndex calls into one request and settles both', async () => {
    const provider = makeProvider();

    // Bring the index socket to OPEN so fetchIndex takes the request path.
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    // Two overlapping callers — the exact race that orphaned a promise.
    const first = provider.fetchIndex!();
    const second = provider.fetchIndex!();

    await vi.waitFor(() => expect(indexSyncRequestCount(indexSocket)).toBe(1));
    // Single-flight: the second caller must NOT put another request on the wire.
    expect(indexSyncRequestCount(indexSocket)).toBe(1);

    // One server response must resolve BOTH callers (neither left pending).
    indexSocket.deliver({ type: 'indexSyncResponse', sessions: [], projects: [] });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ sessions: [], projects: [] });
    expect(secondResult).toEqual({ sessions: [], projects: [] });

    provider.disconnectAll();
  });
});
