/**
 * RemoteTerminalPane — a shell running on the HOST, typed into from here.
 *
 * The host spawns a real PTY in the session's working directory and relays its
 * bytes back over the session-control channel; this pane renders them as a plain
 * scrolling log (see controllerTerminal.ts for why there is no emulator) and
 * sends each submitted line back as input.
 *
 * The pane owns the terminal's lifetime: it opens one on mount and closes it on
 * unmount, so nothing is left running on the host after you close it.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { appendTerminalOutput } from './controllerTerminal';

interface RemoteTerminalPaneProps {
  sessionId: string;
  onClose: () => void;
}

/** Stable per-mount id so the host can tell two open panes apart. */
function newTerminalId(): string {
  return `ctl-${Math.random().toString(36).slice(2, 10)}`;
}

export function RemoteTerminalPane({ sessionId, onClose }: RemoteTerminalPaneProps) {
  const terminalIdRef = useRef<string>(newTerminalId());
  const [output, setOutput] = useState('');
  const [command, setCommand] = useState('');
  const [status, setStatus] = useState<'opening' | 'ready' | 'closed'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  // Shell history, newest last; index is a position walked by Arrow Up/Down.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);

  const send = useCallback(
    (type: 'terminal_open' | 'terminal_input' | 'terminal_close', extra: Record<string, unknown> = {}) => {
      void window.electronAPI?.remoteSessions?.terminal?.({
        sessionId,
        type,
        terminalId: terminalIdRef.current,
        ...extra,
      });
    },
    [sessionId],
  );

  useEffect(() => {
    const terminalId = terminalIdRef.current;
    const off = window.electronAPI?.remoteSessions?.onTerminalEvent?.((event) => {
      if (event.sessionId !== sessionId || event.payload?.terminalId !== terminalId) return;
      if (event.type === 'terminal_output') {
        setOutput((prev) => appendTerminalOutput(prev, String(event.payload.data ?? '')));
      } else if (event.type === 'terminal_ready') {
        setStatus('ready');
        setCwd(typeof event.payload.cwd === 'string' ? event.payload.cwd : null);
      } else if (event.type === 'terminal_exit') {
        setStatus('closed');
      } else if (event.type === 'terminal_error') {
        setError(String(event.payload.error ?? 'The host refused the terminal'));
        setStatus('closed');
      }
    });

    send('terminal_open', { cols: 100, rows: 30 });

    return () => {
      send('terminal_close');
      if (typeof off === 'function') off();
    };
  }, [sessionId, send]);

  // Follow the tail; the pane is short enough that scrolling back is a
  // deliberate act, so there is no "stick only when at the bottom" dance.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const run = () => {
    if (status !== 'ready') return;
    const line = command;
    if (line.trim()) {
      historyRef.current = [...historyRef.current.filter((h) => h !== line), line].slice(-100);
    }
    historyIndexRef.current = null;
    send('terminal_input', { data: `${line}\n` });
    setCommand('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
      return;
    }
    // Ctrl+C goes to the shell as a signal, not as a copy — there is no
    // selection in a one-line input to copy anyway.
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      send('terminal_input', { data: '\u0003' });
      setCommand('');
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const history = historyRef.current;
      if (history.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const current = historyIndexRef.current ?? history.length;
      const next =
        e.key === 'ArrowUp'
          ? Math.max(0, current - 1)
          : Math.min(history.length, current + 1);
      historyIndexRef.current = next;
      setCommand(next >= history.length ? '' : history[next]);
    }
  };

  return (
    <div
      className="remote-terminal-pane flex flex-col min-h-0 border-t"
      style={{ borderColor: 'var(--nim-border)', background: 'var(--nim-bg)', height: '45%' }}
      data-testid="remote-terminal-pane"
    >
      <div
        className="remote-terminal-header flex items-center justify-between px-2 h-6 shrink-0 text-[10px]"
        style={{ color: 'var(--nim-text-muted)' }}
      >
        <span className="truncate" title={cwd ?? undefined}>
          {error ? error : status === 'opening' ? 'starting a shell on the host…' : cwd ?? 'host shell'}
        </span>
        <button
          className="remote-terminal-close px-1"
          style={{ color: 'var(--nim-text-muted)' }}
          onClick={onClose}
          title="Close the terminal"
          aria-label="Close the terminal"
          data-testid="remote-terminal-close"
        >
          ×
        </button>
      </div>

      <pre
        ref={logRef}
        className="remote-terminal-log flex-1 min-h-0 overflow-y-auto px-2 pb-1 text-[11px] leading-[1.45] whitespace-pre-wrap break-words select-text"
        style={{ color: 'var(--nim-text)' }}
        data-testid="remote-terminal-log"
      >
        {output}
      </pre>

      <div className="flex items-center gap-1 px-2 py-1 shrink-0">
        <span style={{ color: 'var(--nim-primary)' }} className="text-[11px] select-none">
          $
        </span>
        <input
          className="remote-terminal-input flex-1 min-w-0 bg-transparent text-[11px] outline-none"
          style={{ color: 'var(--nim-text)' }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={status !== 'ready'}
          placeholder={status === 'closed' ? 'shell closed' : 'command'}
          spellCheck={false}
          autoComplete="off"
          data-testid="remote-terminal-input"
        />
      </div>
    </div>
  );
}
