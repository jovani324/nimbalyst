/**
 * RemoteFileViewer — show a file the HOST holds.
 *
 * A transcript full of `src/thing.ts:42` references is unreadable on a machine
 * that has no checkout. This asks the host for the file over the session-control
 * channel and renders it with line numbers, scrolled to the referenced line.
 *
 * It also happens to be the most convincing thing the popover can show: a page
 * of real source, which is exactly what the disguise is pretending to be.
 */
import { useEffect, useRef, useState } from 'react';
import type { RemoteFileResponse } from '../../types/remoteSessions';

interface RemoteFileViewerProps {
  sessionId: string;
  path: string;
  line?: number;
  onClose: () => void;
}

export function RemoteFileViewer({ sessionId, path, line, onClose }: RemoteFileViewerProps) {
  const [state, setState] = useState<{ loading: boolean; file?: RemoteFileResponse }>({ loading: true });
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    void window.electronAPI?.remoteSessions
      ?.readFile(sessionId, path)
      .then((file) => {
        if (live) setState({ loading: false, file });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState({
          loading: false,
          file: { success: false, error: err instanceof Error ? err.message : 'Could not reach the host.' },
        });
      });
    return () => {
      live = false;
    };
  }, [sessionId, path]);

  // Land on the referenced line rather than the top of the file.
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: 'center' });
  }, [state.file]);

  const file = state.file;
  const lines = file?.success ? file.text.split('\n') : [];

  return (
    <div className="remote-file-viewer flex flex-col flex-1 min-h-0" data-testid="remote-file-viewer">
      <div className="flex items-center gap-2 px-2 h-7 shrink-0">
        <button
          className="remote-session-header-action text-[11px] px-1.5 py-0.5 rounded"
          style={{ color: 'var(--nim-text-muted)' }}
          onClick={onClose}
          data-testid="remote-file-viewer-close"
          title="Back to the transcript"
        >
          {'←'}
        </button>
        <span className="text-[11px] truncate" style={{ color: 'var(--nim-text-muted)' }}>
          {file?.success ? file.path : path}
          {line ? `:${line}` : ''}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2 select-text">
        {state.loading && (
          <div className="text-[12px] py-2" style={{ color: 'var(--nim-text-muted)' }}>
            Reading it on the host…
          </div>
        )}
        {file && !file.success && (
          <div className="text-[12px] py-2" style={{ color: 'var(--nim-warning)' }}>
            {file.error}
          </div>
        )}
        {file?.success && (
          <>
            {lines.map((text, i) => {
              const number = i + 1;
              const isTarget = number === line;
              return (
                <div
                  key={number}
                  ref={isTarget ? lineRef : undefined}
                  className="remote-file-line flex gap-2 text-[12px] leading-[1.45] whitespace-pre"
                  style={isTarget ? { background: 'var(--nim-bg-selected)' } : undefined}
                >
                  <span
                    className="shrink-0 text-right select-none"
                    style={{ color: 'var(--nim-text-muted)', opacity: 0.5, width: '3.5ch' }}
                  >
                    {number}
                  </span>
                  <span style={{ color: 'var(--nim-text)' }}>{text || ' '}</span>
                </div>
              );
            })}
            {file.truncated && (
              <div className="text-[11px] py-2" style={{ color: 'var(--nim-text-muted)' }}>
                Truncated — the rest stayed on the host.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
