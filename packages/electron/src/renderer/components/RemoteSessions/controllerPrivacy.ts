/**
 * Controller privacy features — settings + secret redaction.
 *
 * The controller is meant to be glanced at in public, so it gets banking-app
 * style privacy controls: auto-blur when you look away, hover-to-reveal, and
 * redaction of secret-looking strings. Each is individually toggleable and
 * persisted in the global app-settings store (never localStorage).
 */
import { useCallback, useEffect, useState } from 'react';

export interface ControllerPrivacySettings {
  /** Blur the transcript automatically when the popover loses focus or goes idle. */
  autoBlurOnUnfocus: boolean;
  /** When blurred, reveal messages one at a time on hover instead of all at once. */
  hoverReveal: boolean;
  /** Mask token/key/email-looking strings even when the transcript is not blurred. */
  redactSecrets: boolean;
}

export const DEFAULT_PRIVACY: ControllerPrivacySettings = {
  autoBlurOnUnfocus: true,
  hoverReveal: true,
  redactSecrets: true,
};

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
      | Partial<ControllerPrivacySettings>
      | undefined;
    return { ...DEFAULT_PRIVACY, ...(stored ?? {}) };
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

/** React hook: persisted privacy settings + a per-key toggle. */
export function useControllerPrivacy(): {
  settings: ControllerPrivacySettings;
  toggle: (key: keyof ControllerPrivacySettings) => void;
} {
  const [settings, setSettings] = useState<ControllerPrivacySettings>(DEFAULT_PRIVACY);

  useEffect(() => {
    let live = true;
    void loadControllerPrivacy().then((s) => {
      if (live) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback((key: keyof ControllerPrivacySettings) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      void saveControllerPrivacy(next);
      return next;
    });
  }, []);

  return { settings, toggle };
}
