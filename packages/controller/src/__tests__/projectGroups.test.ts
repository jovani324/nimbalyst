// @vitest-environment node
/**
 * Grouping the session list by workspace.
 *
 * All enabled projects share one index room, so a flat list looks identical
 * whether one project is syncing or four -- which is exactly how it was
 * misread in practice.
 */
import { describe, expect, it } from 'vitest';
import { groupByProject, projectLabel } from '../projectGroups';
import type { RelaySession } from '../relay/relayClient';

const session = (id: string, projectPath: string | null): RelaySession => ({
  sessionId: id,
  title: id,
  provider: 'claude-code',
  messageCount: 0,
  updatedAt: null,
  projectPath,
});

describe('projectLabel', () => {
  it('uses the last path segment', () => {
    expect(projectLabel('/Users/x/_/setup/nimbaly/nimbalyst')).toBe('nimbalyst');
  });

  it('survives a trailing separator', () => {
    expect(projectLabel('/Users/x/backend/')).toBe('backend');
  });
});

describe('groupByProject', () => {
  it('separates workspaces that share one index room', () => {
    const groups = groupByProject([
      session('a', '/Users/x/backend'),
      session('b', '/Users/x/frontend'),
      session('c', '/Users/x/backend'),
    ]);
    expect(groups.map((g) => [g.label, g.sessions.length])).toEqual([
      ['backend', 2],
      ['frontend', 1],
    ]);
  });

  it('keeps undecryptable sessions last instead of letting them lead on count', () => {
    const groups = groupByProject([
      session('a', null),
      session('b', null),
      session('c', null),
      session('d', '/Users/x/backend'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['backend', 'Unknown project']);
  });

  it('treats a blank path as unidentified rather than its own workspace', () => {
    const groups = groupByProject([session('a', '   '), session('b', null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });
});
