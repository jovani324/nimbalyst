// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalStoragePersistence, NOTES_STORAGE_KEY } from '../notes/storage';
import { makeNote, type NotesState } from '@nimbalyst/runtime/notes/model';

const sample: NotesState = {
  tabs: [{ ...makeNote('a', 1), body: 'hi', accent: 'green' }],
  activeId: 'a',
};

describe('createLocalStoragePersistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a state', () => {
    const p = createLocalStoragePersistence();
    p.save(sample);
    expect(p.load()).toEqual(sample);
  });

  it('returns empty state when nothing is stored', () => {
    expect(createLocalStoragePersistence().load()).toEqual({ tabs: [], activeId: null });
  });

  it('degrades corrupt JSON to empty, never throws', () => {
    localStorage.setItem(NOTES_STORAGE_KEY, '{not json');
    expect(createLocalStoragePersistence().load()).toEqual({ tabs: [], activeId: null });
  });

  it('drops malformed tabs and repairs a dangling activeId', () => {
    localStorage.setItem(
      NOTES_STORAGE_KEY,
      JSON.stringify({ tabs: [{ id: 'ok', body: 'x' }, { body: 'no id' }], activeId: 'gone' })
    );
    const loaded = createLocalStoragePersistence().load();
    expect(loaded.tabs.map((t) => t.id)).toEqual(['ok']);
    expect(loaded.activeId).toBe('ok');
  });
});
