// @vitest-environment node
/**
 * Relay-URL precedence.
 *
 * The case that matters is the env override: a host started with
 * NIMBALYST_SYNC_URL syncs to a self-hosted relay while every URL derived from
 * the environment setting still says production. A pairing payload built from
 * the derived URL sends the paired device to a relay the host is not on, where
 * it is refused with a 401 that names no cause.
 */
import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_SYNC_URL,
  PRODUCTION_SYNC_URL,
  resolveSyncServerUrl,
} from '../resolveSyncServerUrl';

describe('resolveSyncServerUrl', () => {
  it('lets NIMBALYST_SYNC_URL beat every other source', () => {
    expect(
      resolveSyncServerUrl({
        envUrl: 'wss://relay.moasfar.app',
        configuredUrl: 'wss://stale.example.com',
        environment: 'development',
        isDevelopmentBuild: true,
      })
    ).toBe('wss://relay.moasfar.app');
  });

  it('ignores a non-ws env value rather than syncing to garbage', () => {
    expect(resolveSyncServerUrl({ envUrl: 'yes', isDevelopmentBuild: true })).toBe(
      PRODUCTION_SYNC_URL
    );
  });

  it('honors a custom configured URL', () => {
    expect(
      resolveSyncServerUrl({ configuredUrl: 'wss://relay.example.app', isDevelopmentBuild: true })
    ).toBe('wss://relay.example.app');
  });

  it('treats a configured production URL as no preference', () => {
    expect(
      resolveSyncServerUrl({
        configuredUrl: PRODUCTION_SYNC_URL,
        environment: 'development',
        isDevelopmentBuild: true,
      })
    ).toBe(DEVELOPMENT_SYNC_URL);
  });

  it('pins production builds to production even when the config says development', () => {
    expect(
      resolveSyncServerUrl({ environment: 'development', isDevelopmentBuild: false })
    ).toBe(PRODUCTION_SYNC_URL);
  });

  it('defaults to production', () => {
    expect(resolveSyncServerUrl({ isDevelopmentBuild: true })).toBe(PRODUCTION_SYNC_URL);
  });
});
