// @vitest-environment node
/**
 * The browser `path` shim.
 *
 * `ClaudeCodeRawParser` calls `path.resolve` on every Read tool result, so this
 * runs on real transcripts. Bare `path-browserify` would reach `process.cwd()`
 * for a relative input and throw in a browser, taking the render down with it —
 * which is the regression these two cases exist to catch.
 */
import { describe, expect, it } from 'vitest';
import path from '../shims/path';

describe('path shim', () => {
  it('leaves an absolute tool-result path alone', () => {
    expect(path.resolve('/Users/x/repo/src/App.tsx')).toBe('/Users/x/repo/src/App.tsx');
  });

  it('roots a relative path instead of reaching for process.cwd()', () => {
    const originalProcess = globalThis.process;
    // @ts-expect-error -- simulating the browser, where there is no process.
    delete globalThis.process;
    try {
      expect(path.resolve('src/App.tsx')).toBe('/src/App.tsx');
    } finally {
      globalThis.process = originalProcess;
    }
  });
});
