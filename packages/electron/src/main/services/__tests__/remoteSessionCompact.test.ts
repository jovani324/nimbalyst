// @vitest-environment node
/**
 * Compaction is a request/response over the SHARED session-control channel:
 * terminal bytes, file reads and every other device's traffic land on the same
 * callback. Matching on requestId is the only thing keeping a stale or foreign
 * rewrite from replacing the draft the user is typing, and nothing on screen
 * would show that it had.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

type ControlMessage = { sessionId: string; type: string; payload?: Record<string, unknown>; sentBy: string };

const sent: ControlMessage[] = [];
let deliver: (message: ControlMessage) => void = () => {};

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/store', () => ({ isControllerMode: () => true }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../SyncManager', () => ({
  getSyncProvider: () => ({
    sendSessionControlMessage: async (message: ControlMessage) => {
      sent.push(message);
    },
    onSessionControlMessage: (callback: (message: ControlMessage) => void) => {
      deliver = callback;
      return () => {};
    },
  }),
}));

const { compactRemotePrompt } = await import('../RemoteSessionService');

/** The requestId the service just put on the wire. */
const lastRequestId = () => String(sent[sent.length - 1].payload!.requestId);

beforeEach(() => {
  sent.length = 0;
});

describe('compactRemotePrompt', () => {
  it('ignores a reply carrying another request\'s id', async () => {
    const pending = compactRemotePrompt('session-1', 'a long rambling draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'prompt_compact', sentBy: 'mobile' });

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: 'someone-else', text: 'wrong rewrite' },
    });
    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), text: '  fix parser  ' },
    });

    await expect(pending).resolves.toEqual({ success: true, text: 'fix parser' });
  });

  it('reports the host\'s own error rather than a generic failure', async () => {
    const pending = compactRemotePrompt('session-1', 'draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compact_error',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), error: 'The claude CLI is not installed on the host.' },
    });

    await expect(pending).resolves.toEqual({
      success: false,
      error: 'The claude CLI is not installed on the host.',
    });
  });

  it('treats an empty rewrite as a failure, so the draft is never wiped', async () => {
    const pending = compactRemotePrompt('session-1', 'draft');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    deliver({
      sessionId: 'session-1',
      type: 'prompt_compacted',
      sentBy: 'desktop',
      payload: { requestId: lastRequestId(), text: '   ' },
    });

    await expect(pending).resolves.toMatchObject({ success: false });
  });
});
