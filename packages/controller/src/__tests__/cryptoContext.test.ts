// @vitest-environment node
/**
 * Secure-context detection.
 *
 * Serving the controller to a second machine over plain `http://<ip>` leaves
 * `crypto.subtle` undefined, and pairing died on "Cannot read properties of
 * undefined (reading 'importKey')" -- which reads like a pairing bug and is not
 * one. The guard exists so the page names the actual cause.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSECURE_CONTEXT_MESSAGE, isCryptoAvailable } from '../relay/crypto';

afterEach(() => vi.unstubAllGlobals());

describe('isCryptoAvailable', () => {
  it('is true where Web Crypto is exposed', () => {
    expect(isCryptoAvailable()).toBe(true);
  });

  it('is false in an insecure context, where crypto exists but subtle does not', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => new Uint8Array(0) });
    expect(isCryptoAvailable()).toBe(false);
  });

  it('is false when there is no crypto object at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(isCryptoAvailable()).toBe(false);
  });

  it('tells the reader how to fix it', () => {
    expect(INSECURE_CONTEXT_MESSAGE).toMatch(/https/);
    expect(INSECURE_CONTEXT_MESSAGE).toMatch(/localhost/);
  });
});
