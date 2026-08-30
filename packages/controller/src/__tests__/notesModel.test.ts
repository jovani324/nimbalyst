// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  emptyNotesState,
  notesReducer,
  tabLabel,
  activeNote,
  makeNote,
  type NotesState,
} from '@nimbalyst/runtime/notes/model';

function withTabs(...ids: string[]): NotesState {
  return {
    tabs: ids.map((id) => makeNote(id, 1)),
    activeId: ids[ids.length - 1] ?? null,
  };
}

describe('notesReducer', () => {
  it('add creates a tab and makes it active', () => {
    const s = notesReducer(emptyNotesState, { type: 'add', id: 'a', now: 10 });
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe('a');
    expect(s.tabs[0].createdAt).toBe(10);
  });

  it('edit and rename bump updatedAt', () => {
    let s = notesReducer(emptyNotesState, { type: 'add', id: 'a', now: 1 });
    s = notesReducer(s, { type: 'edit', id: 'a', body: 'hello', now: 5 });
    s = notesReducer(s, { type: 'rename', id: 'a', title: 'T', now: 7 });
    expect(s.tabs[0]).toMatchObject({ body: 'hello', title: 'T', updatedAt: 7 });
  });

  it('setAccent changes only the target tab', () => {
    let s = withTabs('a', 'b');
    s = notesReducer(s, { type: 'setAccent', id: 'a', accent: 'pink', now: 9 });
    expect(s.tabs.find((t) => t.id === 'a')?.accent).toBe('pink');
    expect(s.tabs.find((t) => t.id === 'b')?.accent).toBe('blue');
  });

  it('closing a non-active tab keeps the active id', () => {
    const s = notesReducer(withTabs('a', 'b', 'c'), { type: 'close', id: 'a' });
    expect(s.tabs.map((t) => t.id)).toEqual(['b', 'c']);
    expect(s.activeId).toBe('c');
  });

  it('closing the active tab falls back to the slot neighbor', () => {
    const start: NotesState = { ...withTabs('a', 'b', 'c'), activeId: 'b' };
    const s = notesReducer(start, { type: 'close', id: 'b' });
    expect(s.activeId).toBe('c'); // the tab that slid into b's index
  });

  it('closing the last tab clears the active id', () => {
    const s = notesReducer(withTabs('a'), { type: 'close', id: 'a' });
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it('select ignores unknown ids', () => {
    const start = withTabs('a', 'b');
    expect(notesReducer(start, { type: 'select', id: 'zzz' })).toBe(start);
  });
});

describe('tabLabel', () => {
  it('prefers the title, then the first non-empty line', () => {
    expect(tabLabel({ ...makeNote('a', 1), title: 'Named' })).toBe('Named');
    expect(tabLabel({ ...makeNote('a', 1), body: '\n  first real\nsecond' })).toBe('first real');
  });

  it('falls back to untitled and truncates long labels', () => {
    expect(tabLabel(makeNote('a', 1))).toBe('untitled');
    expect(tabLabel({ ...makeNote('a', 1), body: 'x'.repeat(40) })).toHaveLength(24);
  });
});

describe('activeNote', () => {
  it('returns the active tab or null', () => {
    expect(activeNote(withTabs('a', 'b'))?.id).toBe('b');
    expect(activeNote(emptyNotesState)).toBeNull();
  });
});
