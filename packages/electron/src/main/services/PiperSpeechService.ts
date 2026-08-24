/**
 * PiperSpeechService — neural TTS playback on the CONTROLLER.
 *
 * The browser speechSynthesis voice is flat; piper (an offline neural TTS) reads
 * the digest with a real voice. Playback is local to the machine that hears it,
 * so this runs in the controller's own main process and never touches the relay:
 * pipe the text through `piper --model <onnx> --output_file <wav>`, then play the
 * wav with `afplay`. One utterance at a time -- a new speak() cancels the one in
 * flight, matching the renderer's "latest reply wins" rule.
 *
 * Everything is best-effort. If the binary or model is missing, speak() reports
 * `fallback: true` and the renderer falls back to speechSynthesis; a missing
 * voice must never wedge the controller.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger';

const log = logger.main;

/** The piper binary. A bare name is resolved on PATH; a spawn error is the tell it is missing. */
export function resolvePiperBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.NIMBALYST_PIPER_BIN?.trim() || 'piper';
}

/**
 * Model paths in priority order: the env override, then the standard install
 * locations. The first that exists wins. A .onnx is 60MB+, so it lives outside
 * the repo -- move it to ~/.local/share/piper or point NIMBALYST_PIPER_MODEL at it.
 */
export function piperModelCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const candidates: string[] = [];
  const override = env.NIMBALYST_PIPER_MODEL?.trim();
  if (override) candidates.push(override);
  candidates.push(join(home, '.local', 'share', 'piper', 'en_US-amy-medium.onnx'));
  candidates.push(join(home, 'piper', 'en_US-amy-medium.onnx'));
  return candidates;
}

/** First model that exists on disk, or null when the voice is not installed. */
export function resolvePiperModel(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir()
): string | null {
  for (const path of piperModelCandidates(env, home)) {
    if (exists(path)) return path;
  }
  return null;
}

export function buildPiperArgs(model: string, outPath: string): string[] {
  return ['--model', model, '--output_file', outPath];
}

/**
 * True when a model resolves on disk. The bin is not stat-checked -- it is a
 * PATH name by default -- so an absent binary surfaces later as a spawn error
 * and the same speechSynthesis fallback.
 */
export function isPiperAvailable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  return resolvePiperModel(env, exists) !== null;
}

export interface SpeakResult {
  success: boolean;
  /** The renderer should read the text with speechSynthesis instead. */
  fallback?: boolean;
  error?: string;
}

let piperChild: ChildProcess | null = null;
let playChild: ChildProcess | null = null;

function killChildren(): void {
  for (const child of [playChild, piperChild]) {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  piperChild = null;
  playChild = null;
}

/** Cancel whatever is speaking. Focus loss and session changes call this. */
export function stopPiperSpeak(): { success: boolean } {
  killChildren();
  return { success: true };
}

/**
 * Pause playback. afplay has no pause of its own, so the running player is
 * frozen with SIGSTOP and thawed with SIGCONT on resume. A no-op when nothing
 * is playing.
 */
export function pausePiperSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGSTOP');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

export function resumePiperSpeak(): { success: boolean } {
  if (playChild && playChild.exitCode === null) {
    try {
      playChild.kill('SIGCONT');
    } catch {
      /* already gone */
    }
  }
  return { success: true };
}

/**
 * Synthesize `text` with piper and play it. Resolves once playback ends (or is
 * superseded). Reports `fallback: true` when the voice is not installed so the
 * caller can read it a plainer way.
 */
export async function piperSpeak(text: string, env: NodeJS.ProcessEnv = process.env): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: 'empty' };

  const model = resolvePiperModel(env);
  if (!model) return { success: false, fallback: true, error: 'no piper model installed' };

  killChildren(); // latest utterance wins

  const bin = resolvePiperBin(env);
  const outPath = join(tmpdir(), `nimbalyst-speak-${process.pid}.wav`);

  return new Promise<SpeakResult>((resolve) => {
    let settled = false;
    const done = (result: SpeakResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const piper = spawn(bin, buildPiperArgs(model, outPath));
    piperChild = piper;
    let stderr = '';
    piper.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    piper.on('error', (err) => {
      log.warn('[PiperSpeechService] piper spawn failed:', err.message);
      done({ success: false, fallback: true, error: err.message });
    });
    piper.on('close', (code) => {
      if (piperChild !== piper) {
        done({ success: true }); // a newer utterance took over
        return;
      }
      if (code !== 0) {
        log.warn('[PiperSpeechService] piper exited', code, '-', stderr.trim().slice(0, 200));
        done({ success: false, fallback: true, error: `piper exited with code ${code}` });
        return;
      }
      const play = spawn('afplay', [outPath]);
      playChild = play;
      play.on('error', (err) => {
        log.warn('[PiperSpeechService] afplay failed:', err.message);
        done({ success: false, error: err.message });
      });
      play.on('close', () => {
        if (playChild === play) playChild = null;
        done({ success: true });
      });
    });
    piper.stdin?.on('error', () => {
      /* the close handler reports why the process went away */
    });
    piper.stdin?.end(trimmed);
  });
}
