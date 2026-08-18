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

const session = (id: string, projectPath: string | null, updatedAt: number | null = null): RelaySession => ({
  sessionId: id,
  title: id,
  provider: 'claude-code',
  messageCount: 0,
  updatedAt,
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

  it('folds a trailing separator into the same workspace', () => {
    // Hosts store both forms; keying the raw path splits one workspace into two
    // groups carrying the same label, which reads as duplicate data.
    const groups = groupByProject([session('a', '/Users/x/backend'), session('b', '/Users/x/backend/')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it('leads with the most recently touched workspace, not the busiest', () => {
    // The relay returns the index in its own order, so ordering by session count
    // buries the session you were in a minute ago under a busier stale one.
    const groups = groupByProject([
      session('a', '/Users/x/busy', 1_000),
      session('b', '/Users/x/busy', 2_000),
      session('c', '/Users/x/recent', 9_000),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['recent', 'busy']);
  });

  it('orders sessions inside a workspace newest first', () => {
    const groups = groupByProject([
      session('old', '/Users/x/backend', 1_000),
      session('new', '/Users/x/backend', 5_000),
    ]);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });

  it('treats a blank path as unidentified rather than its own workspace', () => {
    const groups = groupByProject([session('a', '   '), session('b', null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });
});
