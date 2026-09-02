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
import {
  isSpeechLanguage,
  spokenChoices,
  SPEECH_LANGUAGES,
  type SpeechDigest,
  type SpeechLanguage,
} from '@nimbalyst/runtime/ai/prompts/speechDigest';

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
 * Which voice reads the digest, and how much it costs:
 *   'local'  -- offline piper on this machine, browser synth fallback. Free.
 *   'edge'   -- Microsoft Edge's neural voices; human, real Egyptian Arabic,
 *               no API key. Free (an unofficial endpoint, so best-effort).
 *   'openai' -- OpenAI's voice; needs a configured OpenAI key. Paid.
 * 'local' is the default, so this stays opt-in; each cloud engine falls back to
 * the browser voice on any failure.
 */
export type SpeechEngine = 'local' | 'edge' | 'openai';

export const SPEECH_ENGINES: SpeechEngine[] = ['local', 'edge', 'openai'];

export const SPEECH_ENGINE_LABELS: Record<SpeechEngine, string> = {
  local: 'Local (free)',
  edge: 'Edge neural (free)',
  openai: 'OpenAI (paid)',
};

export function isSpeechEngine(value: unknown): value is SpeechEngine {
  return typeof value === 'string' && (SPEECH_ENGINES as string[]).includes(value);
}

export function nextSpeechEngine(engine: SpeechEngine): SpeechEngine {
  return SPEECH_ENGINES[(SPEECH_ENGINES.indexOf(engine) + 1) % SPEECH_ENGINES.length];
}

export type { SpeechLanguage } from '@nimbalyst/runtime/ai/prompts/speechDigest';

export { SPEECH_LANGUAGES } from '@nimbalyst/runtime/ai/prompts/speechDigest';

export const SPEECH_LANGUAGE_LABELS: Record<SpeechLanguage, string> = {
  en: 'English',
  'ar-EG': 'Egyptian Arabic',
};

/** The compact label shown on the cycling button. */
export const SPEECH_LANGUAGE_SHORT: Record<SpeechLanguage, string> = {
  en: 'EN',
  'ar-EG': 'AR',
};

export function nextSpeechLanguage(language: SpeechLanguage): SpeechLanguage {
  return SPEECH_LANGUAGES[(SPEECH_LANGUAGES.indexOf(language) + 1) % SPEECH_LANGUAGES.length];
}

/** BCP-47 tag for the browser speechSynthesis fallback. */
export function synthLangForLanguage(language: SpeechLanguage): string {
  return language === 'ar-EG' ? 'ar-EG' : 'en-US';
}

/** The OpenAI TTS voices offered in the picker. Keep in sync with OpenAiSpeechService. */
export const OPENAI_SPEECH_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const;
export type OpenAiSpeechVoice = (typeof OPENAI_SPEECH_VOICES)[number];
export const DEFAULT_OPENAI_SPEECH_VOICE: OpenAiSpeechVoice = 'alloy';

export function isOpenAiSpeechVoice(value: unknown): value is OpenAiSpeechVoice {
  return typeof value === 'string' && (OPENAI_SPEECH_VOICES as readonly string[]).includes(value);
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
const ENGINE_KEY = 'controllerSpeechEngine';
const LANGUAGE_KEY = 'controllerSpeechLanguage';
const VOICE_KEY = 'controllerSpeechVoice';

/**
 * Persisted mode plus the player. `speak` replaces whatever is playing — one
 * utterance per session at a time — and `hush` cancels it; the component calls
 * hush on typing and on the popover hiding so a reply never keeps talking into
 * a room the user has turned away from.
 */
export function useControllerSpeech(): {
  mode: SpeechMode;
  setMode: (mode: SpeechMode) => void;
  engine: SpeechEngine;
  setEngine: (engine: SpeechEngine) => void;
  language: SpeechLanguage;
  setLanguage: (language: SpeechLanguage) => void;
  voice: OpenAiSpeechVoice;
  setVoice: (voice: OpenAiSpeechVoice) => void;
  speak: (text: string) => void;
  chime: () => void;
  hush: () => void;
  isSpeaking: boolean;
  paused: boolean;
  stop: () => void;
  pause: () => void;
  resume: () => void;
} {
  const [mode, setModeState] = useState<SpeechMode>('off');
  const [engine, setEngineState] = useState<SpeechEngine>('local');
  const [language, setLanguageState] = useState<SpeechLanguage>('en');
  const [voice, setVoiceState] = useState<OpenAiSpeechVoice>(DEFAULT_OPENAI_SPEECH_VOICE);
  // Read at speak time so `speak` stays stable (the transcript keys its digest
  // effect on it) while still sending the latest engine/language/voice.
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const languageRef = useRef(language);
  languageRef.current = language;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const audioContext = useRef<AudioContext | null>(null);
  const [isSpeaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  // Bumped on every speak/stop so a playback promise that resolves late -- after
  // a newer utterance took over, or after the user hit Stop -- cannot flip the
  // indicator or fire a stale speechSynthesis fallback.
  const speakGen = useRef(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const invoke = window.electronAPI?.invoke;
      if (!invoke) return;
      try {
        const [storedMode, storedEngine, storedLanguage, storedVoice] = await Promise.all([
          invoke('app-settings:get', KEY),
          invoke('app-settings:get', ENGINE_KEY),
          invoke('app-settings:get', LANGUAGE_KEY),
          invoke('app-settings:get', VOICE_KEY),
        ]);
        if (!live) return;
        if (isSpeechMode(storedMode)) setModeState(storedMode);
        if (isSpeechEngine(storedEngine)) setEngineState(storedEngine);
        if (isSpeechLanguage(storedLanguage)) setLanguageState(storedLanguage);
        if (isOpenAiSpeechVoice(storedVoice)) setVoiceState(storedVoice);
      } catch {
        /* the in-memory defaults are a fine answer */
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

  const setEngine = useCallback((next: SpeechEngine) => {
    setEngineState(next);
    void window.electronAPI?.invoke?.('app-settings:set', ENGINE_KEY, next)?.catch?.(() => {
      /* non-fatal */
    });
  }, []);

  const setLanguage = useCallback((next: SpeechLanguage) => {
    setLanguageState(next);
    void window.electronAPI?.invoke?.('app-settings:set', LANGUAGE_KEY, next)?.catch?.(() => {
      /* non-fatal */
    });
  }, []);

  const setVoice = useCallback((next: OpenAiSpeechVoice) => {
    setVoiceState(next);
    void window.electronAPI?.invoke?.('app-settings:set', VOICE_KEY, next)?.catch?.(() => {
      /* non-fatal */
    });
  }, []);

  const hush = useCallback(() => {
    void window.electronAPI?.remoteSessions?.stopSpeak?.().catch(() => {
      /* nothing was playing */
    });
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* no synthesis in this webview */
    }
    setSpeaking(false);
    setPaused(false);
  }, []);

  // The flat webview voice, used only when piper is not installed on the
  // controller. `gen` ties the utterance to the speak() that asked for it, so a
  // fallback that starts after Stop or a newer reply clears the indicator only
  // if it is still the current one.
  const speakWithSynthesis = useCallback((text: string, gen: number) => {
    if (typeof SpeechSynthesisUtterance === 'undefined') {
      if (gen === speakGen.current) setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    // Steer the fallback voice to the chosen language so Egyptian Arabic digests
    // are not read aloud by an English voice.
    const bcp47 = synthLangForLanguage(languageRef.current);
    utterance.lang = bcp47;
    try {
      const prefix = bcp47.toLowerCase().split('-')[0];
      const match = window.speechSynthesis?.getVoices?.().find((v) => v.lang?.toLowerCase().startsWith(prefix));
      if (match) utterance.voice = match;
    } catch {
      /* no voice list here; the lang hint still steers the default */
    }
    utterance.onend = () => {
      if (gen === speakGen.current) {
        setSpeaking(false);
        setPaused(false);
      }
    };
    window.speechSynthesis.speak(utterance);
  }, []);

  // Prefer piper's neural voice in the main process; fall back to speechSynthesis
  // when piper reports it is not installed. Device-agnostic on purpose -- neither
  // path inspects the output device, so it speaks on built-in speakers as readily
  // as on headphones. Any "headphones only" rule belongs on the host digest.
  const speak = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      hush();
      const gen = ++speakGen.current;
      setSpeaking(true);
      setPaused(false);
      const api = window.electronAPI?.remoteSessions;
      if (api?.speak) {
        void api
          .speak(trimmed, {
            engine: engineRef.current,
            language: languageRef.current,
            voice: voiceRef.current,
          })
          .then((result) => {
            if (gen !== speakGen.current) return; // superseded or stopped
            if (!result?.success && result?.fallback) {
              speakWithSynthesis(trimmed, gen);
              return;
            }
            setSpeaking(false);
            setPaused(false);
          })
          .catch(() => {
            if (gen === speakGen.current) speakWithSynthesis(trimmed, gen);
          });
        return;
      }
      speakWithSynthesis(trimmed, gen);
    },
    [hush, speakWithSynthesis]
  );

  // Stop bumps the generation so any in-flight playback promise is ignored, then
  // silences whatever is playing.
  const stop = useCallback(() => {
    speakGen.current++;
    hush();
  }, [hush]);

  const pause = useCallback(() => {
    void window.electronAPI?.remoteSessions?.pauseSpeak?.().catch(() => {
      /* nothing to pause */
    });
    try {
      window.speechSynthesis?.pause();
    } catch {
      /* no synthesis here */
    }
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    void window.electronAPI?.remoteSessions?.resumeSpeak?.().catch(() => {
      /* nothing to resume */
    });
    try {
      window.speechSynthesis?.resume();
    } catch {
      /* no synthesis here */
    }
    setPaused(false);
  }, []);

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
  return useMemo(
    () => ({
      mode,
      setMode,
      engine,
      setEngine,
      language,
      setLanguage,
      voice,
      setVoice,
      speak,
      chime,
      hush,
      isSpeaking,
      paused,
      stop,
      pause,
      resume,
    }),
    [
      mode,
      setMode,
      engine,
      setEngine,
      language,
      setLanguage,
      voice,
      setVoice,
      speak,
      chime,
      hush,
      isSpeaking,
      paused,
      stop,
      pause,
      resume,
    ]
  );
}
