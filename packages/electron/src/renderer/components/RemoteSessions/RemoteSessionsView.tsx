/**
 * RemoteSessionsView — the controller-mode UI.
 *
 * Shows sessions that live on the always-on HOST desktop (this machine is the
 * controller). A project-grouped session list on the left; a live transcript +
 * composer + interactive-prompt surface on the right. All data comes from the
 * main-process RemoteSessionService over IPC (window.electronAPI.remoteSessions)
 * and the remoteSessions atoms — this view owns no local session state.
 */

import { useCallback, useEffect, useState } from 'react';
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

interface RemoteSessionsViewProps {
  isActive: boolean;
}

export function RemoteSessionsView({ isActive }: RemoteSessionsViewProps) {
  const sessionsByProject = useAtomValue(remoteSessionsByProjectAtom);
  const projects = useAtomValue(remoteProjectsAtom);
  const indexLoaded = useAtomValue(remoteIndexLoadedAtom);
  const activeSessionId = useAtomValue(remoteActiveSessionIdAtom);
  const setActiveSessionId = useSetAtom(remoteActiveSessionIdAtom);
  const setIndex = useSetAtom(setRemoteIndexAtom);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);

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

  return (
    <div className="remote-sessions-view flex flex-1 min-h-0 overflow-hidden" data-testid="remote-sessions-view">
      {/* Left: session list */}
      <div
        className="remote-sessions-list flex flex-col w-72 min-w-56 border-r overflow-hidden"
        style={{ borderColor: 'var(--nim-border)', background: 'var(--nim-bg-secondary)' }}
      >
        <div
          className="flex items-center justify-between px-3 h-11 border-b shrink-0"
          style={{ borderColor: 'var(--nim-border)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--nim-text)' }}>
            Remote Sessions
          </span>
          <div className="flex items-center gap-1">
            <button
              className="remote-sessions-new-btn text-xs px-2 py-1 rounded hover:opacity-90"
              style={{ background: 'var(--nim-primary)', color: '#fff' }}
              onClick={() => setShowNewDialog(true)}
              data-testid="remote-sessions-new-button"
              title="Start a new session on the host"
            >
              New
            </button>
            <button
              className="remote-sessions-refresh-btn text-xs px-2 py-1 rounded"
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
              No sessions on the host yet. Use “New” to start one.
            </div>
          )}
          {groupOrder.map((projectId) => {
            const sessions = sessionsByProject.get(projectId) ?? [];
            return (
              <div key={projectId || '__unknown__'} className="remote-project-group">
                <div
                  className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide font-medium"
                  style={{ color: 'var(--nim-text-muted)' }}
                >
                  {projectName(projectId)}
                </div>
                {sessions.map((session) => (
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
      className="remote-session-row flex items-center gap-2 w-full text-left px-3 py-2 text-sm"
      style={{
        background: selected ? 'var(--nim-bg-selected)' : 'transparent',
        color: 'var(--nim-text)',
      }}
      onClick={onSelect}
      data-testid="remote-session-row"
      data-session-id={session.sessionId}
    >
      <span className="flex-1 truncate">{session.title || 'Untitled'}</span>
      {session.isExecuting && (
        <span
          className="remote-session-executing shrink-0 w-2 h-2 rounded-full animate-pulse"
          style={{ background: 'var(--nim-success)' }}
          title="Executing"
        />
      )}
      {session.pendingExecution && !session.isExecuting && (
        <span
          className="remote-session-pending shrink-0 w-2 h-2 rounded-full"
          style={{ background: 'var(--nim-warning)' }}
          title="Prompt queued"
        />
      )}
    </button>
  );
}
