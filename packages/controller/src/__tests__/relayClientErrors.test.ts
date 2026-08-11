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
import { RelayClient } from '../relay/relayClient';

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
