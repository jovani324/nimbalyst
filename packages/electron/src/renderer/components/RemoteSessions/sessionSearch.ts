/**
 * Filtering for the controller's session list.
 *
 * The host accumulates thousands of sessions, and the popover shows maybe eight
 * rows at a time, so scrolling to a session is not a real option. Matching is on
 * title, session id and project name at once, because you rarely know which of
 * the three you have — an id comes from a log line, a title from memory.
 */

import type { RemoteSessionIndexEntry } from '../../types/remoteSessions';

/**
 * Every term must match somewhere (AND across terms), so "auth bug" narrows
 * rather than widens. Id matching is prefix-only: a session id is a UUID, and
 * substring hits on hex fragments are noise, but pasting the first few
 * characters of an id is exactly how you look one up.
 */
export function sessionMatchesQuery(
  session: RemoteSessionIndexEntry,
  projectName: string,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const title = (session.title || '').toLowerCase();
  const id = session.sessionId.toLowerCase();
  const project = projectName.toLowerCase();
  return terms.every(
    (term) => title.includes(term) || project.includes(term) || id.startsWith(term),
  );
}

/** Apply {@link sessionMatchesQuery} to each group, dropping groups left empty. */
export function filterSessionsByProject(
  sessionsByProject: Map<string, RemoteSessionIndexEntry[]>,
  projectName: (projectId: string) => string,
  query: string,
): Map<string, RemoteSessionIndexEntry[]> {
  if (!query.trim()) return sessionsByProject;
  const filtered = new Map<string, RemoteSessionIndexEntry[]>();
  for (const [projectId, sessions] of sessionsByProject) {
    const name = projectName(projectId);
    const matches = sessions.filter((s) => sessionMatchesQuery(s, name, query));
    if (matches.length > 0) filtered.set(projectId, matches);
  }
  return filtered;
}
