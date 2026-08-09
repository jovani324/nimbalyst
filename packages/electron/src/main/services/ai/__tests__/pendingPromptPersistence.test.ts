// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const updateMetadata = vi.fn();
const pushChange = vi.fn();
let syncProvider: { pushChange: typeof pushChange } | null = null;

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    updateMetadata: (...args: unknown[]) => updateMetadata(...args),
  },
}));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => syncProvider }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { warn: vi.fn(), info: vi.fn() } },
}));

import {
  getSessionsWithPendingPrompt,
  normalizeSyncedQuestions,
  resetPendingPromptTracking,
  setSessionPendingPrompt,
} from '../pendingPromptPersistence';

describe('pending-prompt in-memory mirror (NIM-2208)', () => {
  beforeEach(() => {
    resetPendingPromptTracking();
    updateMetadata.mockReset().mockResolvedValue(undefined);
  });

  it('tracks sessions as the bit is set and cleared', async () => {
    expect(getSessionsWithPendingPrompt()).toEqual([]);

    await setSessionPendingPrompt('s1', true);
    await setSessionPendingPrompt('s2', true);
    expect(getSessionsWithPendingPrompt().sort()).toEqual(['s1', 's2']);

    await setSessionPendingPrompt('s1', false);
    expect(getSessionsWithPendingPrompt()).toEqual(['s2']);
  });

  it('does not double-count a session whose bit is set twice', async () => {
    await setSessionPendingPrompt('s1', true);
    await setSessionPendingPrompt('s1', true);
    expect(getSessionsWithPendingPrompt()).toEqual(['s1']);
  });

  it('does not track a session whose write failed', async () => {
    // The mirror stands in for the DB during the reconcile, so it must not claim
    // a bit that was never persisted.
    updateMetadata.mockRejectedValueOnce(new Error('db down'));
    await setSessionPendingPrompt('s1', true);
    expect(getSessionsWithPendingPrompt()).toEqual([]);
  });

  it('ignores an empty session id', async () => {
    await setSessionPendingPrompt('', true);
    expect(getSessionsWithPendingPrompt()).toEqual([]);
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});

describe('syncing a prompt payload to remote devices', () => {
  beforeEach(() => {
    resetPendingPromptTracking();
    updateMetadata.mockReset().mockResolvedValue(undefined);
    pushChange.mockReset();
    syncProvider = { pushChange };
  });

  it('syncs the questions themselves, not just the pending bit', async () => {
    // A controller/phone can only render an SDK AskUserQuestion from this
    // payload — the question never reaches the transcript.
    await setSessionPendingPrompt('s1', true, {
      promptType: 'ask_user_question',
      questionId: 'q-1',
      questions: [
        { question: 'Ship it?', header: 'Release', options: [{ label: 'Yes', description: '' }], multiSelect: false },
      ],
    });

    expect(pushChange).toHaveBeenCalledWith('s1', {
      type: 'metadata_updated',
      metadata: expect.objectContaining({
        hasPendingPrompt: true,
        pendingPromptData: expect.objectContaining({ promptType: 'ask_user_question', questionId: 'q-1' }),
      }),
    });
  });

  it('clears the payload when the prompt resolves', async () => {
    await setSessionPendingPrompt('s1', false);
    expect(pushChange.mock.calls[0][1].metadata).toMatchObject({
      hasPendingPrompt: false,
      pendingPromptData: null,
    });
  });
});

describe('normalizeSyncedQuestions', () => {
  it('defaults every field so a malformed question still renders answerably', () => {
    expect(normalizeSyncedQuestions([{ question: 'Why?', options: [{ label: 'A' }] }])).toEqual([
      { question: 'Why?', header: '', options: [{ label: 'A', description: '' }], multiSelect: false },
    ]);
  });

  it('survives a non-array payload', () => {
    expect(normalizeSyncedQuestions(undefined)).toEqual([]);
  });
});
