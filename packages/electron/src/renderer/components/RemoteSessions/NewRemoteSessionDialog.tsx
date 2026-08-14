/**
 * NewRemoteSessionDialog — ask the host to create a new session in one of its
 * projects, optionally with an initial prompt (images may be pasted into it).
 * Thin form over window.electronAPI.remoteSessions.create.
 */

import { useState } from 'react';
import { ComposerImageStrip, useComposerImages } from './composerImages';
import { toPayload } from './controllerImages';
import type { RemoteProjectEntry } from '../../types/remoteSessions';

interface NewRemoteSessionDialogProps {
  projects: RemoteProjectEntry[];
  /** The session that is open, offered as a parent for the new one. */
  activeSession?: { sessionId: string; title: string; projectId: string };
  onClose: () => void;
  onCreated: (sessionId?: string) => void;
}

export function NewRemoteSessionDialog({
  projects,
  activeSession,
  onClose,
  onCreated,
}: NewRemoteSessionDialogProps) {
  // Following the open session means inheriting its project too, so the picker
  // is pinned there for as long as the parent is selected.
  const [underParent, setUnderParent] = useState(false);
  // A worktree session is cut by the host (branch + checkout + session), so it
  // takes a different request and can't also hang off a parent session.
  const [inWorktree, setInWorktree] = useState(false);
  const [projectId, setProjectId] = useState(
    activeSession?.projectId || projects[0]?.projectId || '',
  );
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerImages = useComposerImages();
  const { images, preparing, clear: clearImages } = composerImages;

  const handleCreate = async () => {
    const api = window.electronAPI?.remoteSessions;
    if (!api || !projectId) return;
    setCreating(true);
    setError(null);
    const parent = underParent && !inWorktree ? activeSession : undefined;
    try {
      const text = prompt.trim();

      if (inWorktree) {
        const wt = await api.createWorktree(projectId);
        if (!wt.success || !wt.sessionId) {
          setError(wt.error ?? 'Host could not create the worktree');
          return;
        }
        if (text || images.length) {
          await api.sendPrompt(
            wt.sessionId,
            text || 'Take a look at this image.',
            images.length ? toPayload(images) : undefined,
          );
        }
        clearImages();
        onCreated(wt.sessionId);
        return;
      }

      // The create request carries text only — images have to travel as bytes on
      // a prompt control message, so with attachments we create the session bare
      // and immediately queue the prompt (which the host stages as attachments).
      const res = await api.create({
        projectId: parent ? parent.projectId : projectId,
        initialPrompt: images.length ? undefined : text || undefined,
        parentSessionId: parent?.sessionId,
      });
      if (!res.success) {
        setError(res.error ?? 'Host could not create the session');
        return;
      }
      if (images.length && res.sessionId) {
        await api.sendPrompt(res.sessionId, text || 'Take a look at this image.', toPayload(images));
      }
      clearImages();
      onCreated(res.sessionId);
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

        <label
          className="remote-new-session-worktree flex items-center gap-2 text-xs"
          style={{ color: 'var(--nim-text-muted)' }}
        >
          <input
            type="checkbox"
            checked={inWorktree}
            onChange={(e) => setInWorktree(e.target.checked)}
            data-testid="remote-new-session-worktree"
          />
          <span className="truncate">On a new branch (git worktree)</span>
        </label>

        {activeSession && !inWorktree && (
          <label
            className="remote-new-session-parent flex items-center gap-2 text-xs"
            style={{ color: 'var(--nim-text-muted)' }}
          >
            <input
              type="checkbox"
              checked={underParent}
              onChange={(e) => setUnderParent(e.target.checked)}
              data-testid="remote-new-session-parent"
            />
            <span className="truncate">Continue under “{activeSession.title || 'the open session'}”</span>
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--nim-text-muted)' }}>
          Project
          <select
            className="rounded px-2 py-1.5 text-sm outline-none"
            style={{ background: 'var(--nim-bg-secondary)', color: 'var(--nim-text)', border: '1px solid var(--nim-border)' }}
            value={underParent && activeSession ? activeSession.projectId : projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={underParent}
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
            onPaste={(e) => void composerImages.handlePaste(e)}
            placeholder="What should the agent start on?  (paste an image to attach)"
            data-testid="remote-new-session-prompt"
          />
        </label>

        <ComposerImageStrip {...composerImages} />

        {(error || composerImages.error) && (
          <div className="text-xs" style={{ color: 'var(--nim-error)' }}>
            {error ?? composerImages.error}
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
            style={{
              background: 'var(--nim-primary)',
              color: '#fff',
              opacity: creating || !projectId || preparing > 0 ? 0.5 : 1,
            }}
            onClick={() => void handleCreate()}
            disabled={creating || !projectId || preparing > 0}
            data-testid="remote-new-session-create"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
