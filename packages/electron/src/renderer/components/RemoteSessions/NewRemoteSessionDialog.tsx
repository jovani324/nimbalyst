/**
 * NewRemoteSessionDialog — ask the host to create a new session in one of its
 * projects, optionally with an initial prompt. Thin form over
 * window.electronAPI.remoteSessions.create.
 */

import { useState } from 'react';
import type { RemoteProjectEntry } from '../../types/remoteSessions';

interface NewRemoteSessionDialogProps {
  projects: RemoteProjectEntry[];
  onClose: () => void;
  onCreated: (sessionId?: string) => void;
}

export function NewRemoteSessionDialog({ projects, onClose, onCreated }: NewRemoteSessionDialogProps) {
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? '');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    const api = window.electronAPI?.remoteSessions;
    if (!api || !projectId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.create({
        projectId,
        initialPrompt: prompt.trim() || undefined,
      });
      if (res.success) {
        onCreated(res.sessionId);
      } else {
        setError(res.error ?? 'Host could not create the session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="remote-new-session-overlay fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
      data-testid="remote-new-session-overlay"
    >
      <div
        className="remote-new-session-dialog w-96 max-w-[90vw] rounded-lg p-4 flex flex-col gap-3"
        style={{ background: 'var(--nim-bg)', border: '1px solid var(--nim-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold" style={{ color: 'var(--nim-text)' }}>
          New session on host
        </div>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--nim-text-muted)' }}>
          Project
          <select
            className="rounded px-2 py-1.5 text-sm outline-none"
            style={{ background: 'var(--nim-bg-secondary)', color: 'var(--nim-text)', border: '1px solid var(--nim-border)' }}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            data-testid="remote-new-session-project"
          >
            {projects.length === 0 && <option value="">No projects available</option>}
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name || p.projectId}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--nim-text-muted)' }}>
          Initial prompt (optional)
          <textarea
            className="rounded px-2 py-1.5 text-sm outline-none resize-none"
            style={{ background: 'var(--nim-bg-secondary)', color: 'var(--nim-text)', border: '1px solid var(--nim-border)' }}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent start on?"
            data-testid="remote-new-session-prompt"
          />
        </label>

        {error && (
          <div className="text-xs" style={{ color: 'var(--nim-error)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            className="text-sm px-3 py-1.5 rounded"
            style={{ color: 'var(--nim-text-muted)', border: '1px solid var(--nim-border)' }}
            onClick={onClose}
            data-testid="remote-new-session-cancel"
          >
            Cancel
          </button>
          <button
            className="text-sm px-3 py-1.5 rounded"
            style={{ background: 'var(--nim-primary)', color: '#fff', opacity: creating || !projectId ? 0.5 : 1 }}
            onClick={() => void handleCreate()}
            disabled={creating || !projectId}
            data-testid="remote-new-session-create"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
