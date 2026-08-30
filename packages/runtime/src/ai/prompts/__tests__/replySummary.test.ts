// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { normalizeReplySummary, MAX_SUMMARY_OUTPUT_CHARS } from '../replySummary';

describe('normalizeReplySummary', () => {
  it('strips code fences and trims', () => {
    expect(normalizeReplySummary('```\nEnforced via grants.\n```')).toBe('Enforced via grants.');
  });

  it('clamps overly long output with an ellipsis', () => {
    const out = normalizeReplySummary('x'.repeat(MAX_SUMMARY_OUTPUT_CHARS + 50));
    expect(out.length).toBe(MAX_SUMMARY_OUTPUT_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});
