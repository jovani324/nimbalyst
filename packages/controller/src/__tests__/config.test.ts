// @vitest-environment node
/**
 * Pairing-payload parsing.
 *
 * Every rejection here corresponds to a real failure hit while bringing the
 * controller up against the live relay: a clipboard that still held a shell
 * command, a seed truncated by console copy-paste (41 of 44 chars), and older
 * payloads that predate the personal ids the room id is built from. Each of
 * those otherwise presents as "connected, but the host has no sessions", which
 * sends you debugging the relay instead of the input.
 */
import { describe, expect, it } from 'vitest';
import { parsePairingPayload } from '../config';

const SEED = 'A'.repeat(44);

const validPayload = {
  version: 5,
  serverUrl: 'wss://relay.example.app',
  encryptionKeySeed: SEED,
  personalOrgId: 'organization-live-abc',
  personalUserId: 'member-live-def',
};

describe('parsePairingPayload', () => {
  it('reads a v5 JSON payload', () => {
    expect(parsePairingPayload(JSON.stringify(validPayload))).toEqual({
      relayUrl: 'wss://relay.example.app',
      orgId: 'organization-live-abc',
      userId: 'member-live-def',
      seed: SEED,
    });
  });

  it('reads the nimbalyst://pair deep link the QR encodes', () => {
    const data = encodeURIComponent(btoa(JSON.stringify(validPayload)));
    expect(parsePairingPayload(`nimbalyst://pair?data=${data}`).seed).toBe(SEED);
  });

  it('rejects a stale clipboard holding a shell command', () => {
    expect(() => parsePairingPayload('pbpaste | node spike/list-sessions.mjs')).toThrow(
      /does not look like a pairing payload/
    );
  });

  it('rejects a seed truncated by copy-paste rather than accepting a key that decrypts nothing', () => {
    const truncated = { ...validPayload, encryptionKeySeed: 'A'.repeat(41) };
    expect(() => parsePairingPayload(JSON.stringify(truncated))).toThrow(/41 chars, expected 44/);
  });

  it('rejects a payload predating the personal ids the room id needs', () => {
    const { personalOrgId, personalUserId, ...v3 } = validPayload;
    expect(() => parsePairingPayload(JSON.stringify({ ...v3, version: 3 }))).toThrow(
      /personalOrgId and personalUserId/
    );
  });

  it('rejects a payload with no usable relay URL', () => {
    const { serverUrl, ...noUrl } = validPayload;
    expect(() => parsePairingPayload(JSON.stringify(noUrl))).toThrow(/no usable relay URL/);
  });
});
