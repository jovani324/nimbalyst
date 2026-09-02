/**
 * Controller privacy features — settings + secret redaction.
 *
 * The controller is meant to be glanced at in public, so it gets banking-app
 * style privacy controls: auto-blur when you look away, hover-to-reveal, and
 * redaction of secret-looking strings. Each is individually toggleable and
 * persisted in the global app-settings store (never localStorage).
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * How the transcript hides itself for a glance in public:
 *  - uniform:       dim the whole pane as one; a hover lifts it back.
 *  - reading-light: keep it dim; a soft light around the cursor reveals nearby lines.
 *  - per-message:   blur each message; the one under the pointer sharpens.
 *  - disguise:      show a page of plausible source until you point at the pane.
 * The first three take effect only while hidden (auto-hide on idle, or the eye
 * toggle); 'disguise' is always on until hovered.
 */
export type ControllerRevealMode = 'uniform' | 'reading-light' | 'per-message' | 'disguise';

export const REVEAL_MODES: Array<{ id: ControllerRevealMode; label: string }> = [
  { id: 'uniform', label: 'Uniform' },
  { id: 'reading-light', label: 'Reading light' },
  { id: 'per-message', label: 'Per message' },
  { id: 'disguise', label: 'Disguise' },
];

export interface ControllerPrivacySettings {
  /** Hide the transcript automatically when the popover loses focus or goes idle. */
  autoBlurOnUnfocus: boolean;
  /** How the transcript hides and reveals (see ControllerRevealMode). */
  revealMode: ControllerRevealMode;
  /** Mask token/key/email-looking strings even when the transcript is not hidden. */
  redactSecrets: boolean;
  /** Show session titles as plausible file paths; the real title on hover. */
  disguiseTitles: boolean;
  /** Distill each finished reply into a note/document automatically. */
  autoDistill: boolean;
}

export const DEFAULT_PRIVACY: ControllerPrivacySettings = {
  autoBlurOnUnfocus: true,
  revealMode: 'uniform',
  redactSecrets: true,
  disguiseTitles: false,
  autoDistill: false,
};

/**
 * Merge stored settings over defaults, migrating the pre-revealMode shape: the
 * old `disguiseTranscript` boolean becomes `revealMode: 'disguise'`. The old
 * `hoverReveal` boolean was on by default, so it signalled no real choice — every
 * other install (and new ones) lands on the improved 'uniform' default instead of
 * the patchy per-message blur.
 */
export function normalizeControllerPrivacy(
  stored: Partial<ControllerPrivacySettings> & { hoverReveal?: boolean; disguiseTranscript?: boolean } = {},
): ControllerPrivacySettings {
  const revealMode: ControllerRevealMode =
    stored.revealMode ?? (stored.disguiseTranscript ? 'disguise' : DEFAULT_PRIVACY.revealMode);
  return {
    autoBlurOnUnfocus: stored.autoBlurOnUnfocus ?? DEFAULT_PRIVACY.autoBlurOnUnfocus,
    revealMode,
    redactSecrets: stored.redactSecrets ?? DEFAULT_PRIVACY.redactSecrets,
    disguiseTitles: stored.disguiseTitles ?? DEFAULT_PRIVACY.disguiseTitles,
    autoDistill: stored.autoDistill ?? DEFAULT_PRIVACY.autoDistill,
  };
}

const PRIVACY_KEY = 'controllerPrivacy';

/** Idle time before auto-blur kicks in, when autoBlurOnUnfocus is on. */
export const AUTO_BLUR_IDLE_MS = 45_000;

const MASK = '••••••••';

// Ordered most-specific first. Conservative on purpose: only shapes that are
// almost never ordinary prose, so normal text isn't mangled.
const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // emails
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic-style keys
  /gh[posru]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWTs
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex (SHAs, hex tokens)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64 blobs
];

/** Replace secret-looking substrings with a fixed mask (hides length too). */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** Load persisted privacy settings, merged over defaults. */
export async function loadControllerPrivacy(): Promise<ControllerPrivacySettings> {
  try {
    const stored = (await window.electronAPI?.invoke?.('app-settings:get', PRIVACY_KEY)) as
      | (Partial<ControllerPrivacySettings> & { hoverReveal?: boolean; disguiseTranscript?: boolean })
      | undefined;
    return normalizeControllerPrivacy(stored ?? {});
  } catch {
    return DEFAULT_PRIVACY;
  }
}

async function saveControllerPrivacy(settings: ControllerPrivacySettings): Promise<void> {
  try {
    await window.electronAPI?.invoke?.('app-settings:set', PRIVACY_KEY, settings);
  } catch {
    /* non-fatal — settings just won't persist */
  }
}

/**
 * One shared copy of the settings for the whole window.
 *
 * Both panes read these — the transcript owns the settings menu, the session
 * list needs `disguiseTitles` — so per-component state would let you toggle
 * "disguise titles" and watch the list ignore it. Module state plus a listener
 * set keeps every hook instance on the same value without pulling privacy
 * settings into the global atom store.
 */
let current: ControllerPrivacySettings = DEFAULT_PRIVACY;
let loaded = false;
const listeners = new Set<(s: ControllerPrivacySettings) => void>();

function publish(next: ControllerPrivacySettings): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** React hook: persisted privacy settings + a per-key toggle. */
export function useControllerPrivacy(): {
  settings: ControllerPrivacySettings;
  toggle: (key: keyof ControllerPrivacySettings) => void;
  set: <K extends keyof ControllerPrivacySettings>(key: K, value: ControllerPrivacySettings[K]) => void;
} {
  const [settings, setSettings] = useState<ControllerPrivacySettings>(current);

  useEffect(() => {
    listeners.add(setSettings);
    if (!loaded) {
      loaded = true;
      void loadControllerPrivacy().then(publish);
    } else {
      setSettings(current);
    }
    return () => {
      listeners.delete(setSettings);
    };
  }, []);

  const toggle = useCallback((key: keyof ControllerPrivacySettings) => {
    const next = { ...current, [key]: !current[key] };
    void saveControllerPrivacy(next);
    publish(next);
  }, []);

  const set = useCallback(
    <K extends keyof ControllerPrivacySettings>(key: K, value: ControllerPrivacySettings[K]) => {
      const next = { ...current, [key]: value };
      void saveControllerPrivacy(next);
      publish(next);
    },
    [],
  );

  return { settings, toggle, set };
}
