// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RemoteSessionIndexEntry } from '../../../types/remoteSessions';
import { filterSessionsByProject, sessionMatchesQuery } from '../sessionSearch';

const session = (sessionId: string, title: string): RemoteSessionIndexEntry =>
  ({ sessionId, title, projectId: 'p1', provider: 'claude-code', messageCount: 0, lastMessageAt: 0, createdAt: 0, updatedAt: 0 });

describe('sessionMatchesQuery', () => {
  const s = session('7f3c9a20-1111-2222-3333-444455556666', 'Fix the auth redirect');

  it('matches on title, project name and an id prefix', () => {
    expect(sessionMatchesQuery(s, 'nimbalyst', 'auth')).toBe(true);
    expect(sessionMatchesQuery(s, 'nimbalyst', 'NIMBA')).toBe(true);
    expect(sessionMatchesQuery(s, 'nimbalyst', '7f3c9a20')).toBe(true);
  });

  it('does not match an id fragment from the middle', () => {
    // Hex substrings collide constantly; only a prefix means the user pasted an id.
    expect(sessionMatchesQuery(s, 'nimbalyst', '2222')).toBe(false);
  });

  it('requires every term to match, so more words narrow the list', () => {
    expect(sessionMatchesQuery(s, 'nimbalyst', 'auth redirect')).toBe(true);
    expect(sessionMatchesQuery(s, 'nimbalyst', 'auth tracker')).toBe(false);
  });

  it('matches everything on an empty or whitespace query', () => {
    expect(sessionMatchesQuery(s, 'nimbalyst', '   ')).toBe(true);
  });
});

describe('filterSessionsByProject', () => {
  const groups = new Map([
    ['p1', [session('a1', 'Fix auth'), session('a2', 'Tracker grid')]],
    ['p2', [session('b1', 'Docs pass')]],
  ]);
  const projectName = (id: string) => (id === 'p1' ? 'nimbalyst' : 'website');

  it('drops groups with no surviving session', () => {
    const filtered = filterSessionsByProject(groups, projectName, 'auth');
    expect([...filtered.keys()]).toEqual(['p1']);
    expect(filtered.get('p1')?.map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('keeps a whole project when the project name matches', () => {
    const filtered = filterSessionsByProject(groups, projectName, 'website');
    expect([...filtered.keys()]).toEqual(['p2']);
  });

  it('returns the original map untouched when the query is empty', () => {
    expect(filterSessionsByProject(groups, projectName, '')).toBe(groups);
  });
});
