/**
 * Spoken replies for the Electron controller popover.
 *
 * The host digests each final assistant reply into a few sentences plus the
 * answers a keypress can give (see RemoteSpeechDigestService); this decides
 * which message to digest, whether to say it, and plays it. The decisions are
 * pure functions so they test without a window; the hook owns persistence
 * (app-settings, never localStorage — same rule as controllerReplyStyle) and
 * the speechSynthesis queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { spokenChoices, type SpeechDigest } from '@nimbalyst/runtime/ai/prompts/speechDigest';

export { applyChoiceDirective } from '@nimbalyst/runtime/ai/prompts/replyStyle';

/** Off; only when the agent waits on you; every final reply. */
export type SpeechMode = 'off' | 'needs-you' | 'all';

export const SPEECH_MODES: SpeechMode[] = ['off', 'needs-you', 'all'];

export const SPEECH_MODE_LABELS: Record<SpeechMode, string> = {
  off: 'Mute',
  'needs-you': 'Speak',
  all: 'Speak all',
};

export function isSpeechMode(value: unknown): value is SpeechMode {
  return typeof value === 'string' && (SPEECH_MODES as string[]).includes(value);
}

export function nextSpeechMode(mode: SpeechMode): SpeechMode {
  return SPEECH_MODES[(SPEECH_MODES.indexOf(mode) + 1) % SPEECH_MODES.length];
}

/**
 * The reply worth digesting: the last assistant prose once the agent has
 * stopped. While it is still running the last message is a fragment, and a
 * digest of a fragment is a tell that the speech is not keeping up.
 */
export function pickDigestTarget(
  viewMessages: TranscriptViewMessage[],
  isExecuting: boolean
): { id: string; text: string } | null {
  if (isExecuting) return null;
  for (let i = viewMessages.length - 1; i >= 0; i--) {
    const m = viewMessages[i];
    if (m.type === 'user_message') return null;
    if (m.type === 'assistant_message' && m.text?.trim()) return { id: String(m.id), text: m.text };
  }
  return null;
}

/** Whether this digest is spoken under the mode, or only badged. */
export function shouldSpeak(digest: SpeechDigest, mode: SpeechMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return digest.needsYou;
}

/** The sentences read aloud: the digest, then the numbered answers. */
export function composeUtterance(digest: SpeechDigest): string {
  const choices = spokenChoices(digest.choices);
  return choices ? `${digest.spoken} ${choices}` : digest.spoken;
}

const KEY = 'controllerSpeechMode';

/**
 * Persisted mode plus the player. `speak` replaces whatever is playing — one
 * utterance per session at a time — and `hush` cancels it; the component calls
 * hush on typing and on the popover hiding so a reply never keeps talking into
 * a room the user has turned away from.
 */
export function useControllerSpeech(): {
  mode: SpeechMode;
  setMode: (mode: SpeechMode) => void;
  speak: (text: string) => void;
  chime: () => void;
  hush: () => void;
} {
  const [mode, setModeState] = useState<SpeechMode>('off');
  const audioContext = useRef<AudioContext | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const stored = await window.electronAPI?.invoke?.('app-settings:get', KEY);
        if (live && isSpeechMode(stored)) setModeState(stored);
      } catch {
        /* the in-memory default is a fine answer */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const setMode = useCallback((next: SpeechMode) => {
    setModeState(next);
    void window.electronAPI?.invoke?.('app-settings:set', KEY, next)?.catch?.(() => {
      /* non-fatal */
    });
  }, []);

  const hush = useCallback(() => {
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* no synthesis in this webview */
    }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!text.trim() || typeof SpeechSynthesisUtterance === 'undefined') return;
      hush();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      window.speechSynthesis.speak(utterance);
    },
    [hush]
  );

  // A short two-tone blip for "done" — quieter than a sentence, louder than nothing.
  const chime = useCallback(() => {
    try {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      audioContext.current ??= new Ctx();
      const ctx = audioContext.current;
      const now = ctx.currentTime;
      for (const [freq, at] of [
        [880, 0],
        [1320, 0.12],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.08, now + at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.12);
      }
    } catch {
      /* no audio output here */
    }
  }, []);

  useEffect(() => hush, [hush]);

  // Stable identity: the component keys effects on this object.
  return useMemo(() => ({ mode, setMode, speak, chime, hush }), [mode, setMode, speak, chime, hush]);
}
