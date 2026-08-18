/**
 * Group the session list by the host workspace each session belongs to.
 *
 * Every enabled project syncs into the same personal index room, and the only
 * thing separating them is each entry's encrypted project id (the host's
 * workspace path). Until this existed the list rendered flat, which reads as
 * "only one project is syncing" when four of them are.
 */
import type { RelaySession } from './relay/relayClient';

export interface ProjectGroup {
  /** Stable identity for React keys and collapse state. */
  key: string;
  /** Full workspace path, or null when it could not be decrypted. */
  path: string | null;
  /** Last path segment -- the workspace name a person recognises. */
  label: string;
  sessions: RelaySession[];
}

const UNGROUPED_KEY = '\u0000ungrouped';

/**
 * Strip trailing separators so one workspace is one key.
 *
 * Hosts store both `/a/b` and `/a/b/`. Keying on the raw path splits those into
 * two groups carrying the *same* label, which reads as duplicated data rather
 * than as a bug.
 */
function normalizePath(path: string): string {
  // A root path is all separators, so keep it rather than normalizing it away.
  return path.replace(/[/\\]+$/, '') || path;
}

/** Trailing slashes and Windows separators both appear in stored paths. */
export function projectLabel(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function groupByProject(sessions: RelaySession[]): ProjectGroup[] {
  const byPath = new Map<string, ProjectGroup>();

  for (const session of sessions) {
    const raw = session.projectPath?.trim();
    const path = raw ? normalizePath(raw) : null;
    const key = path ?? UNGROUPED_KEY;
    let group = byPath.get(key);
    if (!group) {
      group = {
        key,
        path,
        // Without a key the project id stays encrypted, so say that rather than
        // inventing a name -- it is the same signal as an undecryptable title.
        label: path ? projectLabel(path) : 'Unknown project',
        sessions: [],
      };
      byPath.set(key, group);
    }
    group.sessions.push(session);
  }

  const groups = [...byPath.values()];
  for (const group of groups) group.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  // Most recently touched project first -- the relay returns the index in its
  // own order, so ordering by session count buries the session you were in a
  // minute ago under a busier one from last week. Anything unidentified still
  // sinks to the bottom rather than leading the list.
  const lastTouched = (g: ProjectGroup) =>
    g.sessions.reduce((newest, s) => Math.max(newest, s.updatedAt ?? 0), 0);
  groups.sort((a, b) => {
    if ((a.path === null) !== (b.path === null)) return a.path === null ? 1 : -1;
    if (lastTouched(b) !== lastTouched(a)) return lastTouched(b) - lastTouched(a);
    return a.label.localeCompare(b.label);
  });
  return groups;
}
