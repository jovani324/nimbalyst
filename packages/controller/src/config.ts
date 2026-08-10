/**
 * Controller pairing config.
 *
 * The controller pairs the same way a phone does: it consumes the host's
 * pairing payload. Accepting a paste (or a `nimbalyst://pair` deep link) avoids
 * the clipboard/console dance entirely -- the host's own "Copy payload" button
 * produces exactly this.
 *
 * Storage note: this is a standalone web/Tauri app, not the Electron renderer,
 * so there is no app-settings store or PGLite to route through. localStorage is
 * the only local primitive here; the repo's "never use localStorage" rule is
 * about the Electron renderer, where those alternatives exist.
 */
const STORAGE_KEY = 'nimbalyst.controller.pairing';

export interface ControllerConfig {
  relayUrl: string;
  orgId: string;
  userId: string;
  seed: string;
}

export interface PairingPayload {
  version?: number;
  serverUrl?: string;
  encryptionKeySeed?: string;
  personalOrgId?: string;
  personalUserId?: string;
}

/** 32 bytes of base64 is 43+ chars; the host enforces the same floor. */
const MIN_SEED_LENGTH = 43;

/**
 * Parse the raw JSON payload or a `nimbalyst://pair?data=<base64>` deep link.
 * Throws with a message meant to be shown in the UI.
 */
export function parsePairingPayload(text: string): ControllerConfig {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Paste the pairing payload from the host first.');

  let payload: PairingPayload;
  try {
    const link = trimmed.match(/[?&]data=([^&\s]+)/);
    const json = link ? atob(decodeURIComponent(link[1])) : trimmed;
    payload = JSON.parse(json);
  } catch {
    throw new Error(
      'That does not look like a pairing payload. Use the host’s Settings → Sync → Copy payload button.'
    );
  }

  const seed = payload.encryptionKeySeed?.trim();
  if (!seed || seed.length < MIN_SEED_LENGTH) {
    // A truncated seed connects fine and silently decrypts nothing, which reads
    // as "the host has no sessions" -- so reject it here instead.
    throw new Error(
      `Encryption seed is missing or truncated (${seed?.length ?? 0} chars, expected 44).`
    );
  }

  // The room id is built from these two; a v4-or-older payload predates them.
  const absent = [
    !payload.personalOrgId && 'personalOrgId',
    !payload.personalUserId && 'personalUserId',
  ].filter(Boolean);
  if (absent.length) {
    throw new Error(
      `Payload (version ${payload.version ?? '?'}) is missing ${absent.join(' and ')}. ` +
        'The host must be signed in to sync when the payload is generated.'
    );
  }

  const relayUrl = payload.serverUrl?.trim();
  if (!relayUrl || !/^wss?:\/\//.test(relayUrl)) {
    throw new Error(`Payload has no usable relay URL (got ${relayUrl || 'nothing'}).`);
  }

  return {
    relayUrl,
    orgId: payload.personalOrgId!,
    userId: payload.personalUserId!,
    seed,
  };
}

export function loadConfig(): ControllerConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ControllerConfig) : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: ControllerConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}
