/**
 * The notes pane -- an Antinote-vibe scratchpad shared by every controller.
 *
 * State is a useReducer over the pure notesReducer, seeded from `initialState`.
 * Persistence is injected: a debounced effect hands each new state to
 * `onPersist`, so the standalone controller can write localStorage and the
 * Electron popover can write app-settings without this component knowing which.
 *
 * It owns none of the relay -- text leaves via onSendToComposer (push, never
 * auto-send) and arrives via clipText (the host's last reply, offered for a
 * one-click clip). onExit lets a keyboard-driven user drop back to the session
 * (Esc). That keeps the pane a leaf: no network, no session handle.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import {
  ACCENTS,
  activeNote,
  emptyNotesState,
  notesReducer,
  tabLabel,
  type Accent,
  type NotesState,
} from './model';
import { parseSlash, stripTrailingCommand } from './slash';
import './NotesPanel.css';

const SAVE_DEBOUNCE_MS = 300;

/** The full keymap, kept here so the `?` cheat-sheet can never drift from the
 *  handler below -- both read this one list. `mod` renders as ⌘ on macOS. */
export const NOTES_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '⌥N', label: 'Toggle notes / session' },
  { keys: 'Esc', label: 'Back to session' },
  { keys: 'mod ↩', label: 'Send note to composer' },
  { keys: 'mod ⇧ C', label: 'Clip last reply' },
  { keys: 'mod ⇧ N', label: 'New note' },
  { keys: 'mod ⇧ W', label: 'Close note' },
  { keys: 'mod ⇧ [ / ]', label: 'Previous / next note' },
  { keys: 'mod 1–9', label: 'Jump to note' },
  { keys: 'mod ⌥ 1–4', label: 'Accent blue/amber/green/pink' },
  { keys: '/send /new /clear /accent', label: 'Slash on the last line' },
];

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // A non-secure context has no randomUUID; the fallback only needs to be
  // unique within this list, not cryptographically strong.
  return `n-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function NotesPanel({
  initialState,
  onPersist,
  onSendToComposer,
  clipText,
  onExit,
}: {
  initialState?: NotesState;
  onPersist?: (state: NotesState) => void;
  onSendToComposer: (text: string) => void;
  clipText: string | null;
  onExit?: () => void;
}) {
  const [state, dispatch] = useReducer(notesReducer, initialState ?? emptyNotesState);
  const [showHelp, setShowHelp] = useState(false);

  // One debounced writer. Skips the first render so mounting is never a
  // redundant write of what we just seeded.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!onPersist) return;
    const t = setTimeout(() => onPersist(state), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state, onPersist]);

  const note = activeNote(state);

  const runSlash = useCallback(
    (body: string): boolean => {
      const cmd = parseSlash(body);
      if (!cmd || !note) return false;
      switch (cmd.command) {
        case 'send':
          onSendToComposer(stripTrailingCommand(body).trim());
          return true;
        case 'new':
          dispatch({ type: 'add', id: newId(), now: Date.now() });
          return true;
        case 'clear':
          dispatch({ type: 'edit', id: note.id, body: '', now: Date.now() });
          return true;
        case 'accent':
          dispatch({ type: 'setAccent', id: note.id, accent: cmd.accent, now: Date.now() });
          dispatch({ type: 'edit', id: note.id, body: stripTrailingCommand(body), now: Date.now() });
          return true;
      }
    },
    [note, onSendToComposer]
  );

  const clip = () => {
    if (!note || !clipText) return;
    const joined = note.body ? `${note.body.replace(/\s+$/, '')}\n\n${clipText}` : clipText;
    dispatch({ type: 'edit', id: note.id, body: joined, now: Date.now() });
  };

  const addNote = () => dispatch({ type: 'add', id: newId(), now: Date.now() });

  const cycleTab = (dir: 1 | -1) => {
    if (state.tabs.length < 2) return;
    const i = state.tabs.findIndex((t) => t.id === state.activeId);
    const next = state.tabs[(i + dir + state.tabs.length) % state.tabs.length];
    dispatch({ type: 'select', id: next.id });
  };

  const jumpTab = (i: number) => {
    const t = state.tabs[i];
    if (t) dispatch({ type: 'select', id: t.id });
  };

  // The keymap. Runs on the panel (bubbles up from the textarea), so it works
  // whether the caret is in the body or focus is on a button. Plain Enter and
  // the slash trigger stay on the textarea's own handler.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      onExit?.();
      return;
    }
    if (showHelp && e.key === '?') {
      setShowHelp(false);
      return;
    }
    if (!note) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      onSendToComposer(note.body.trim());
    } else if (e.shiftKey && k === 'c') {
      e.preventDefault();
      clip();
    } else if (e.shiftKey && k === 'n') {
      e.preventDefault();
      addNote();
    } else if (e.shiftKey && k === 'w') {
      e.preventDefault();
      dispatch({ type: 'close', id: note.id });
    } else if (e.shiftKey && (k === ']' || k === '}')) {
      e.preventDefault();
      cycleTab(1);
    } else if (e.shiftKey && (k === '[' || k === '{')) {
      e.preventDefault();
      cycleTab(-1);
    } else if (e.altKey && /^[1-4]$/.test(e.key)) {
      e.preventDefault();
      dispatch({ type: 'setAccent', id: note.id, accent: ACCENTS[Number(e.key) - 1], now: Date.now() });
    } else if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      jumpTab(Number(e.key) - 1);
    }
  };

  const helpButton = (
    <button
      className={`nimba-notes-help-btn${showHelp ? ' is-active' : ''}`}
      onClick={() => setShowHelp((s) => !s)}
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts"
    >
      {'?'}
    </button>
  );

  const helpOverlay = showHelp && (
    <div className="nimba-notes-help" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setShowHelp(false)}>
      <div className="nimba-notes-help-card" onClick={(e) => e.stopPropagation()}>
        <div className="nimba-notes-help-title">Shortcuts</div>
        <dl className="nimba-notes-help-list">
          {NOTES_SHORTCUTS.map((s) => (
            <div className="nimba-notes-help-row" key={s.keys}>
              <dt className="nimba-notes-help-keys">{s.keys}</dt>
              <dd className="nimba-notes-help-label">{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );

  if (!note) {
    return (
      <div className="nimba-notes nimba-notes-empty" onKeyDown={onKeyDown}>
        <p className="nimba-notes-muted">No notes yet.</p>
        <button className="nimba-notes-new" onClick={addNote}>
          + New note
        </button>
      </div>
    );
  }

  return (
    <div className={`nimba-notes nimba-notes-${note.accent}`} onKeyDown={onKeyDown}>
      {helpOverlay}
      <div className="nimba-notes-tabs" role="tablist">
        {state.tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === state.activeId}
            className={`nimba-notes-tab nimba-notes-tab-${t.accent}${
              t.id === state.activeId ? ' is-active' : ''
            }`}
            onClick={() => dispatch({ type: 'select', id: t.id })}
            title={tabLabel(t)}
          >
            <span className="nimba-notes-tab-label">{tabLabel(t)}</span>
            <span
              className="nimba-notes-tab-close"
              role="button"
              aria-label="Close note"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'close', id: t.id });
              }}
            >
              ×
            </span>
          </button>
        ))}
        <button className="nimba-notes-add" onClick={addNote} title="New note (⌘⇧N)">
          +
        </button>
      </div>

      <textarea
        className="nimba-notes-body"
        value={note.body}
        spellCheck={false}
        placeholder="Scratch…"
        title="Slash on the last line: /send  /new  /clear  /accent blue|amber|green|pink"
        onChange={(e) => dispatch({ type: 'edit', id: note.id, body: e.target.value, now: Date.now() })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            const body = (e.target as HTMLTextAreaElement).value;
            if (parseSlash(body) && runSlash(body)) e.preventDefault();
          }
        }}
        autoFocus
      />

      <div className="nimba-notes-toolbar">
        <div className="nimba-notes-accents">
          {ACCENTS.map((a: Accent) => (
            <button
              key={a}
              className={`nimba-notes-accent nimba-notes-accent-${a}${
                note.accent === a ? ' is-active' : ''
              }`}
              aria-label={`Accent ${a}`}
              onClick={() => dispatch({ type: 'setAccent', id: note.id, accent: a, now: Date.now() })}
            />
          ))}
        </div>
        {helpButton}
        <button
          className="nimba-notes-clip"
          onClick={clip}
          disabled={!clipText}
          aria-label="Clip reply"
          title="Clip: append the host's last reply (⌘⇧C)"
        >
          {'↧'}
        </button>
        <button
          className="nimba-notes-send"
          onClick={() => onSendToComposer(note.body.trim())}
          disabled={!note.body.trim()}
          aria-label="Send to composer"
          title="Send: push this note into the composer (⌘↩)"
        >
          {'→'}
        </button>
      </div>
    </div>
  );
}
