// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { redactSecrets, normalizeControllerPrivacy } from '../controllerPrivacy';

describe('normalizeControllerPrivacy (revealMode migration)', () => {
  it('maps the legacy disguiseTranscript flag to disguise mode', () => {
    expect(normalizeControllerPrivacy({ disguiseTranscript: true }).revealMode).toBe('disguise');
  });

  it('lands legacy installs (no revealMode) on the uniform default', () => {
    // hoverReveal was on by default, so it signalled no real choice.
    expect(normalizeControllerPrivacy({ hoverReveal: true }).revealMode).toBe('uniform');
    expect(normalizeControllerPrivacy({}).revealMode).toBe('uniform');
  });

  it('keeps an explicit revealMode and preserves the other fields', () => {
    const s = normalizeControllerPrivacy({ revealMode: 'per-message', redactSecrets: false });
    expect(s.revealMode).toBe('per-message');
    expect(s.redactSecrets).toBe(false);
    expect(s.autoBlurOnUnfocus).toBe(true); // default fills the gap
  });
});

describe('redactSecrets', () => {
  it('masks emails', () => {
    expect(redactSecrets('ping me at jane.doe@example.com ok')).toBe('ping me at •••••••• ok');
  });

  it('masks API keys and tokens', () => {
    expect(redactSecrets('key sk-abcdef0123456789ABCD done')).toContain('••••••••');
    expect(redactSecrets('key sk-abcdef0123456789ABCD done')).not.toContain('sk-abcdef');
    expect(redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).not.toContain('ghp_ABCDEF');
  });

  it('masks JWTs and long hex', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(redactSecrets(`auth ${jwt}`)).not.toContain('eyJhbGci');
    const sha = 'a'.repeat(40);
    expect(redactSecrets(`commit ${sha}`)).toBe('commit ••••••••');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Done! Created test_control11 as an empty file.';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('is a no-op on empty input', () => {
    expect(redactSecrets('')).toBe('');
  });
});
