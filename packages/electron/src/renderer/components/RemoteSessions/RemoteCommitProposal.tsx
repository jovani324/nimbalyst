/**
 * RemoteCommitProposal — approve (or reject) a commit the agent proposed, from
 * the controller.
 *
 * InteractivePromptWidget only knows permissions and questions, and the desktop's
 * own commit UI is a full-width panel that assumes a local repository. This is
 * the popover-sized equivalent: the message (editable, because a commit subject
 * is the one thing you actually want to fix before it lands), the file list, and
 * the two answers. The reply travels as a `git_commit` prompt response, which the
 * host already understands.
 */

import { useState } from 'react';
import type { CommitProposalContent } from './pendingPrompt';

export interface CommitProposalResponse {
  action: 'committed' | 'cancelled';
  files?: string[];
  message?: string;
}

interface RemoteCommitProposalProps {
  content: CommitProposalContent;
  isSubmitting: boolean;
  onRespond: (response: CommitProposalResponse) => void;
}

export function RemoteCommitProposal({ content, isSubmitting, onRespond }: RemoteCommitProposalProps) {
  const [message, setMessage] = useState(content.commitMessage);
  const files = content.filesToStage ?? [];

  return (
    <div
      className="remote-commit-proposal flex flex-col gap-2 rounded p-2"
      style={{ background: 'var(--nim-bg-secondary)', border: '1px solid var(--nim-primary)' }}
      data-testid="remote-commit-proposal"
    >
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--nim-text-muted)' }}>
        <span>Commit</span>
        <span>·</span>
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      <textarea
        className="remote-commit-proposal-message w-full resize-none rounded px-2 py-1 text-[12px] outline-none"
        style={{
          background: 'var(--nim-bg)',
          color: 'var(--nim-text)',
          border: '1px solid var(--nim-border)',
          minHeight: 52,
          maxHeight: 140,
        }}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        data-testid="remote-commit-proposal-message"
        aria-label="Commit message"
      />

      {files.length > 0 && (
        <div
          className="remote-commit-proposal-files text-[11px] overflow-y-auto"
          style={{ color: 'var(--nim-text-muted)', maxHeight: 96 }}
        >
          {files.map((f) => (
            <div key={f} className="truncate" title={f}>
              {f}
            </div>
          ))}
        </div>
      )}

      {content.reasoning && (
        <div className="text-[11px]" style={{ color: 'var(--nim-text-muted)' }}>
          {content.reasoning}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          className="remote-commit-proposal-commit px-2 py-1 rounded text-[12px]"
          style={{
            background: 'var(--nim-primary)',
            color: '#fff',
            opacity: isSubmitting || !message.trim() ? 0.5 : 1,
          }}
          disabled={isSubmitting || !message.trim()}
          onClick={() => onRespond({ action: 'committed', files, message: message.trim() })}
          data-testid="remote-commit-proposal-commit"
        >
          Commit
        </button>
        <button
          className="remote-commit-proposal-cancel px-2 py-1 rounded text-[12px]"
          style={{ border: '1px solid var(--nim-border)', color: 'var(--nim-text)' }}
          disabled={isSubmitting}
          onClick={() => onRespond({ action: 'cancelled' })}
          data-testid="remote-commit-proposal-cancel"
        >
          Don't commit
        </button>
      </div>
    </div>
  );
}
