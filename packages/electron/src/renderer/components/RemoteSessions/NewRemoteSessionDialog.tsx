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
  onClose: () => void;
  onCreated: (sessionId?: string) => void;
}

export function NewRemoteSessionDialog({ projects, onClose, onCreated }: NewRemoteSessionDialogProps) {
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? '');
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
    try {
      const text = prompt.trim();
      // The create request carries text only — images have to travel as bytes on
      // a prompt control message, so with attachments we create the session bare
      // and immediately queue the prompt (which the host stages as attachments).
      const res = await api.create({
        projectId,
        initialPrompt: images.length ? undefined : text || undefined,
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
