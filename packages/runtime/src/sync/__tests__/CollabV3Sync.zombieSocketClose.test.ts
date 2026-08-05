// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * Regression lock: closing a zombie index socket must not crash the host.
 *
 * `connectToIndex()` discards a socket that was created but never opened. The
 * `ws` package aborts a CONNECTING handshake ASYNCHRONOUSLY -- `close()` returns
 * normally and the failure arrives later as an `error` event. So the `try/catch`
 * around `close()` cannot catch it, and if the handler was detached first the
 * event has no listener and Node escalates it to an uncaught exception.
 *
 * On 2026-08-04 that killed the fork HOST every time the controller connected
 * (`Mobile device connected: M04 (Controller), syncing settings...` ->
 * `connectToIndex()` -> `Uncaught exception: WebSocket was closed before the
 * connection was established`), so controller approvals had nothing listening
 * on the other end.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** Aborts that arrived with no handler attached -- i.e. would-be crashes. */
  static unhandledAborts = 0;

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();

  close = vi.fn(() => {
    const wasConnecting = this.readyState === FakeWebSocket.CONNECTING;
    this.readyState = FakeWebSocket.CLOSED;
    if (!wasConnecting) return;
    // Mirror `ws`: the abort surfaces on a later tick, after any try/catch
    // around close() has already returned.
    queueMicrotask(() => {
      const abort = new Error('WebSocket was closed before the connection was established');
      if (this.onerror) {
        this.onerror(abort as unknown as Event);
      } else {
        FakeWebSocket.unhandledAborts += 1;
      }
    });
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('CollabV3 zombie index socket cleanup', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.unhandledAborts = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swallows the async abort when discarding a socket that never opened', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
    });

    // The index socket is created on construction. Leave it CONNECTING so the
    // next connectToIndex() treats it as a zombie -- exactly the state the host
    // was in when the controller connected.
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    const zombie = FakeWebSocket.instances[0];
    expect(zombie.readyState).toBe(FakeWebSocket.CONNECTING);

    // This is the controller's approval path: it reconnects the index first.
    void provider
      .sendSessionControlMessage!({
        sessionId: 'session-1',
        type: 'prompt_response',
        timestamp: 1,
        sentBy: 'mobile',
      })
      .catch(() => {
        /* connection never completes in this test; irrelevant to the assertion */
      });

    await vi.waitFor(() => expect(zombie.close).toHaveBeenCalled());
    // Let the queued abort land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(FakeWebSocket.unhandledAborts).toBe(0);

    provider.disconnectAll();
  });

});

// reconnectIndex() carries the same detach-then-close pattern and got the same
// guard, but it is not covered here: it bails early while a handshake is in
// flight, and a CONNECTING socket IS an in-flight handshake, so the branch is
// unreachable through the public API without faking internal state.
