// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * Regression lock: index.css must parse.
 *
 * A single dropped `}` makes Vite's postcss step throw at startup and the app
 * boots to a blank window -- no React error, no component stack, nothing that
 * points at CSS. It cost a full debugging round on 2026-08-05, when the merge
 * of 329 upstream commits appended upstream's rules onto the end of the fork's
 * controller-popover block and ate its final closing brace. The file parsed as
 * one unterminated rule 600 lines long.
 *
 * index.css is on the fork's known conflict list (.claude/rules/fork-upstream-sync.md)
 * precisely because both sides append to it, so this will be attempted again.
 */
const cssPath = fileURLToPath(new URL('../index.css', import.meta.url));

describe('renderer/index.css', () => {
  it('parses as valid CSS', () => {
    const css = readFileSync(cssPath, 'utf8');
    // postcss reports an unclosed block only when the parse is forced to finish,
    // so parse eagerly rather than leaving it lazy.
    expect(() => postcss.parse(css, { from: cssPath }).nodes.length).not.toThrow();
  });
});
