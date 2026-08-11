/**
 * The one place that decides which relay this app syncs to.
 *
 * This lived inline in `initializeSync` and again in `getPersonalDocSyncConfig`,
 * while the Sync settings panel derived a third answer from the environment
 * setting alone. That third answer is what the QR/pairing payload advertised, so
 * a host running against a self-hosted relay handed out `wss://sync.nimbalyst.com`
 * -- and the paired device was refused with a 401 by a relay the host was not
 * even connected to. Everything that needs the URL now asks this function.
 */
export const PRODUCTION_SYNC_URL = 'wss://sync.nimbalyst.com';
export const DEVELOPMENT_SYNC_URL = 'ws://localhost:8790';

const isWsUrl = (value: string | undefined | null): value is string =>
  !!value && /^wss?:\/\//.test(value);

export interface SyncServerUrlInputs {
  /** `serverUrl` from the persisted sync config; may be stale. */
  configuredUrl?: string | null;
  /** `environment` from the persisted sync config. */
  environment?: string | null;
  /** `process.env.NIMBALYST_SYNC_URL`. */
  envUrl?: string | null;
  /** Production builds pin production sync regardless of the environment setting. */
  isDevelopmentBuild: boolean;
}

export function resolveSyncServerUrl({
  configuredUrl,
  environment,
  envUrl,
  isDevelopmentBuild,
}: SyncServerUrlInputs): string {
  // Self-hosted personal-lane relay: the env override wins over everything.
  if (isWsUrl(envUrl)) return envUrl;
  // An explicit non-default serverUrl in the config also redirects sync.
  if (isWsUrl(configuredUrl) && configuredUrl !== PRODUCTION_SYNC_URL) return configuredUrl;
  // The environment setting is honored in dev builds only.
  if (isDevelopmentBuild && environment === 'development') return DEVELOPMENT_SYNC_URL;
  return PRODUCTION_SYNC_URL;
}
