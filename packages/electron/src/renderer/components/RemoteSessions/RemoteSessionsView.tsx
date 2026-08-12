/**
 * RemoteSessionsView — the controller-mode UI.
 *
 * Shows sessions that live on the always-on HOST desktop (this machine is the
 * controller). A project-grouped session list on the left; a live transcript +
 * composer + interactive-prompt surface on the right. All data comes from the
 * main-process RemoteSessionService over IPC (window.electronAPI.remoteSessions)
 * and the remoteSessions atoms — this view owns no local session state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  remoteSessionsByProjectAtom,
  remoteProjectsAtom,
  remoteIndexLoadedAtom,
  remoteActiveSessionIdAtom,
  setRemoteIndexAtom,
} from '../../store/atoms/remoteSessions';
import type { RemoteSessionIndexEntry } from '../../types/remoteSessions';
import { RemoteSessionTranscript } from './RemoteSessionTranscript';
import { NewRemoteSessionDialog } from './NewRemoteSessionDialog';
import { filterSessionsByProject } from './sessionSearch';

interface RemoteSessionsViewProps {
  isActive: boolean;
}

export function RemoteSessionsView({ isActive }: RemoteSessionsViewProps) {
  const allSessionsByProject = useAtomValue(remoteSessionsByProjectAtom);
  const projects = useAtomValue(remoteProjectsAtom);
  const indexLoaded = useAtomValue(remoteIndexLoadedAtom);
  const activeSessionId = useAtomValue(remoteActiveSessionIdAtom);
  const setActiveSessionId = useSetAtom(remoteActiveSessionIdAtom);
  const setIndex = useSetAtom(setRemoteIndexAtom);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.remoteSessions) return;
    setLoading(true);
    setError(null);
    try {
      const index = await window.electronAPI.remoteSessions.list();
      setIndex(index);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load remote sessions');
    } finally {
      setLoading(false);
    }
  }, [setIndex]);

  // Fetch the index whenever the view becomes active (and once on mount).
  useEffect(() => {
    if (isActive) {
      void refresh();
    }
  }, [isActive, refresh]);

  const projectName = useCallback(
    (projectId: string) => {
      if (!projectId) return 'Unknown project';
      const p = projects.find((proj) => proj.projectId === projectId);
      return p?.name ?? projectId;
    },
    [projects],
  );

  const searching = query.trim().length > 0;
  const sessionsByProject = useMemo(
    () => filterSessionsByProject(allSessionsByProject, projectName, query),
    [allSessionsByProject, projectName, query],
  );

  // Build an ordered list of [projectId, sessions] groups: known projects first
  // (by recent activity), then any orphan group with empty projectId.
  const groupOrder: string[] = [
    ...projects
      .slice()
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .map((p) => p.projectId)
      .filter((id) => sessionsByProject.has(id)),
    ...[...sessionsByProject.keys()].filter((id) => !projects.some((p) => p.projectId === id)),
  ];

  // A search shows every hit regardless of which groups you had collapsed —
  // otherwise a match hides inside a collapsed group and the list reads empty.
  const isCollapsed = (projectId: string) => !searching && collapsedProjects.has(projectId);
  const toggleProject = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Flattened session order for keyboard navigation — Arrow Up/Down moves the
  // active session through the list (unless the user is typing in the composer).
  // Collapsed groups are skipped: arrowing into a row you cannot see looks broken.
  const flatSessionIds: string[] = groupOrder.flatMap((projectId) =>
    isCollapsed(projectId) ? [] : (sessionsByProject.get(projectId) ?? []).map((s) => s.sessionId),
  );
  const moveSelection = (delta: number) => {
    if (flatSessionIds.length === 0) return;
    const cur = activeSessionId ? flatSessionIds.indexOf(activeSessionId) : -1;
    const nextIdx = cur < 0 ? 0 : Math.min(flatSessionIds.length - 1, Math.max(0, cur + delta));
    setActiveSessionId(flatSessionIds[nextIdx]);
  };

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // The list may be collapsed (display:none), where focus() is a no-op —
        // wait for the re-render that reveals it.
        setListCollapsed(false);
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (flatSessionIds.length === 0) return;
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, flatSessionIds, activeSessionId, setActiveSessionId]);

  return (
    <div className="remote-sessions-view flex flex-1 min-h-0 overflow-hidden" data-testid="remote-sessions-view">
      {/* Collapsed rail: just a burger to bring the list back. */}
      {listCollapsed && (
        <div
          className="remote-sessions-list remote-sessions-list-header flex flex-col items-center w-9 min-w-9 border-r shrink-0"
          style={{ borderColor: 'var(--nim-border)', background: 'var(--nim-bg-secondary)' }}
        >
          <button
            className="h-8 w-9 flex items-center justify-center text-sm"
            style={{ color: 'var(--nim-text-muted)' }}
            onClick={() => setListCollapsed(false)}
            data-testid="remote-sessions-expand-button"
            title="Show sessions"
          >
            ☰
          </button>
        </div>
      )}

      {/* Left: session list */}
      <div
        className="remote-sessions-list flex flex-col w-72 min-w-56 border-r overflow-hidden"
        style={{
          borderColor: 'var(--nim-border)',
          background: 'var(--nim-bg-secondary)',
          display: listCollapsed ? 'none' : undefined,
        }}
      >
        <div
          className="remote-sessions-list-header flex items-center justify-between px-2 h-8 border-b shrink-0"
          style={{ borderColor: 'var(--nim-border)' }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              className="text-sm shrink-0"
              style={{ color: 'var(--nim-text-muted)' }}
              onClick={() => setListCollapsed(true)}
              data-testid="remote-sessions-collapse-button"
              title="Hide session list"
            >
              ☰
            </button>
            <span className="text-[11px] truncate" style={{ color: 'var(--nim-text-muted)' }}>
              Remote Sessions
            </span>
          </div>
          <div className="flex items-center">
            <button
              className="remote-session-header-action text-[13px] px-1.5 py-0.5 rounded"
              style={{ color: 'var(--nim-primary)' }}
              onClick={() => setShowNewDialog(true)}
              data-testid="remote-sessions-new-button"
              title="Start a new session on the host"
              aria-label="Start a new session on the host"
            >
              +
            </button>
            <button
              className="remote-session-header-action text-[11px] px-1.5 py-0.5 rounded"
              style={{ color: 'var(--nim-text-muted)' }}
              onClick={() => void refresh()}
              disabled={loading}
              data-testid="remote-sessions-refresh-button"
              title="Refresh"
            >
              {loading ? '…' : '↻'}
            </button>
          </div>
        </div>

        <div
          className="remote-sessions-search flex items-center gap-1 px-2 py-1 border-b shrink-0"
          style={{ borderColor: 'var(--nim-border)' }}
        >
          <input
            ref={searchRef}
            className="flex-1 min-w-0 rounded px-2 py-1 text-xs outline-none"
            style={{
              background: 'var(--nim-bg)',
              color: 'var(--nim-text)',
              border: '1px solid var(--nim-border)',
            }}
            placeholder="Search name or id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Arrow/Enter walk the results without leaving the box — the global
              // handler deliberately ignores keys typed into an input.
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                moveSelection(e.key === 'ArrowDown' ? 1 : -1);
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!activeSessionId || !flatSessionIds.includes(activeSessionId)) moveSelection(1);
                return;
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setQuery('');
              }
            }}
            data-testid="remote-sessions-search-input"
          />
          {searching && (
            <button
              className="remote-sessions-search-clear text-xs px-1 shrink-0"
              style={{ color: 'var(--nim-text-muted)' }}
              onClick={() => setQuery('')}
              title="Clear search"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--nim-error)' }}>
              {error}
            </div>
          )}
          {!indexLoaded && loading && (
            <div className="px-3 py-4 text-xs" style={{ color: 'var(--nim-text-muted)' }}>
              Loading sessions from host…
            </div>
          )}
          {indexLoaded && groupOrder.length === 0 && (
            <div className="px-3 py-4 text-xs" style={{ color: 'var(--nim-text-muted)' }}>
              {searching ? `No session matches “${query.trim()}”.` : 'No sessions on the host yet. Use “+” to start one.'}
            </div>
          )}
          {groupOrder.map((projectId) => {
            const sessions = sessionsByProject.get(projectId) ?? [];
            const collapsed = isCollapsed(projectId);
            return (
              <div key={projectId || '__unknown__'} className="remote-project-group">
                <button
                  className="remote-project-group-header flex items-center gap-1 w-full text-left px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide font-medium"
                  style={{ color: 'var(--nim-text-muted)' }}
                  onClick={() => toggleProject(projectId)}
                  data-testid="remote-project-group-header"
                  title={collapsed ? 'Show sessions' : 'Hide sessions'}
                  aria-expanded={!collapsed}
                >
                  <span className="shrink-0" style={{ width: 8 }}>
                    {collapsed ? '▸' : '▾'}
                  </span>
                  <span className="truncate">{projectName(projectId)}</span>
                  <span className="shrink-0" style={{ opacity: 0.7 }}>
                    {sessions.length}
                  </span>
                </button>
                {!collapsed &&
                  sessions.map((session) => (
                    <RemoteSessionRow
                      key={session.sessionId}
                      session={session}
                      selected={session.sessionId === activeSessionId}
                      onSelect={() => setActiveSessionId(session.sessionId)}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: transcript / composer */}
      <div className="remote-sessions-detail flex flex-col flex-1 min-w-0 min-h-0" style={{ background: 'var(--nim-bg)' }}>
        {activeSessionId ? (
          <RemoteSessionTranscript key={activeSessionId} sessionId={activeSessionId} isActive={isActive} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm" style={{ color: 'var(--nim-text-muted)' }}>
            Select a session to view its transcript
          </div>
        )}
      </div>

      {showNewDialog && (
        <NewRemoteSessionDialog
          projects={projects}
          onClose={() => setShowNewDialog(false)}
          onCreated={(sessionId) => {
            setShowNewDialog(false);
            void refresh();
            if (sessionId) setActiveSessionId(sessionId);
          }}
        />
      )}
    </div>
  );
}

interface RemoteSessionRowProps {
  session: RemoteSessionIndexEntry;
  selected: boolean;
  onSelect: () => void;
}

function RemoteSessionRow({ session, selected, onSelect }: RemoteSessionRowProps) {
  return (
    <button
      className="remote-session-row flex items-center gap-1.5 w-full text-left px-3 py-0.5 text-[12px] leading-5"
      style={{
        background: selected ? 'var(--nim-bg-selected)' : 'transparent',
        color: 'var(--nim-text)',
      }}
      onClick={onSelect}
      data-testid="remote-session-row"
      data-session-id={session.sessionId}
      title={session.title || 'Untitled'}
    >
      <span className="flex-1 truncate">{session.title || 'Untitled'}</span>
      {/* A blocked session is the one you actually have to open — it outranks
          "running" and "queued", which resolve on their own. */}
      {session.hasPendingPrompt && (
        <span
          className="remote-session-awaiting-answer shrink-0 leading-none"
          style={{ color: 'var(--nim-warning)', fontSize: 11 }}
          title="Waiting for your answer"
        >
          ?
        </span>
      )}
      {session.isExecuting && (
        <span
          className="remote-session-executing shrink-0 w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: 'var(--nim-success)' }}
          title="Executing"
        />
      )}
      {session.pendingExecution && !session.isExecuting && (
        <span
          className="remote-session-pending shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: 'var(--nim-warning)' }}
          title="Prompt queued"
        />
      )}
    </button>
  );
}
