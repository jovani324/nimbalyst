/**
 * Controller disguise — make the popover read as an open code editor.
 *
 * Blurring hides content but advertises that something is being hidden: a
 * smeared pane at a coffee shop is more conspicuous than a boring one. The
 * disguise instead substitutes plausible, boring content — session titles become
 * file paths, the transcript becomes a page of source — and only the pane the
 * pointer is actually over shows the real thing.
 *
 * Everything here is derived from the session id with a stable hash, so the same
 * session always wears the same fake name and the fake page doesn't churn on
 * every render (which would be its own tell).
 */

/** FNV-1a. Small, stable across reloads, and good enough to spread short ids. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A deterministic pseudo-random sequence seeded from a string. */
function seeded(seed: string): () => number {
  let state = hash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const DIRS = [
  'src',
  'src/lib',
  'src/utils',
  'src/components',
  'src/services',
  'src/hooks',
  'lib',
  'internal',
  'pkg/api',
  'app/models',
];

const NAMES = [
  'index',
  'client',
  'parser',
  'registry',
  'resolver',
  'schema',
  'transport',
  'handlers',
  'formatter',
  'cache',
  'session',
  'adapter',
  'loader',
  'queue',
  'metrics',
  'router',
];

const EXTS = ['ts', 'tsx', 'go', 'py', 'rs'];

/** A stable, plausible file path to show instead of a session title. */
export function disguisedName(sessionId: string): string {
  const rand = seeded(sessionId);
  const dir = DIRS[Math.floor(rand() * DIRS.length)];
  const name = NAMES[Math.floor(rand() * NAMES.length)];
  const ext = EXTS[Math.floor(rand() * EXTS.length)];
  return `${dir}/${name}.${ext}`;
}

/** A stable, plausible folder to show in place of a project/workspace name, so a
 *  disguised session list reads as a file tree rather than named workspaces. */
export function disguisedFolder(projectId: string): string {
  const rand = seeded(`${projectId}:folder`);
  return DIRS[Math.floor(rand() * DIRS.length)];
}

const CODE_LINES = [
  'import { createClient } from "./client";',
  'import type { Options, Result } from "./types";',
  '',
  'const DEFAULT_TIMEOUT_MS = 30_000;',
  'const MAX_RETRIES = 3;',
  '',
  'export async function resolve(input: string, options: Options = {}) {',
  '  const client = createClient(options.endpoint ?? DEFAULT_ENDPOINT);',
  '  const started = performance.now();',
  '',
  '  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {',
  '    try {',
  '      const response = await client.send(input, { timeout: DEFAULT_TIMEOUT_MS });',
  '      if (!response.ok) continue;',
  '      return normalize(response.body);',
  '    } catch (err) {',
  '      if (attempt === MAX_RETRIES - 1) throw err;',
  '    }',
  '  }',
  '',
  '  throw new Error(`resolve failed after ${MAX_RETRIES} attempts`);',
  '}',
  '',
  'function normalize(body: unknown): Result {',
  '  if (typeof body !== "object" || body === null) {',
  '    return { items: [], truncated: false };',
  '  }',
  '  const { items = [], cursor } = body as Record<string, never>;',
  '  return { items, truncated: Boolean(cursor) };',
  '}',
];

/**
 * A page of code to show in place of the transcript. Rotated by session id so
 * two sessions side by side don't show byte-identical text.
 */
export function disguisedCode(sessionId: string, lines = CODE_LINES.length): string[] {
  const offset = hash(sessionId) % CODE_LINES.length;
  return Array.from({ length: lines }, (_, i) => CODE_LINES[(offset + i) % CODE_LINES.length]);
}
