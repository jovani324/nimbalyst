import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import {
  applyRemoteIndexChangeAtom,
  remotePendingPromptAtomFamily,
  remoteSessionsAtom,
  remoteSessionsByProjectAtom,
  setRemoteIndexAtom,
  setRemotePendingPromptAtom,
  type RemotePendingPromptData,
} from '../remoteSessions';
import type {
  RemoteIndexChangeEntry,
  RemoteSessionIndexEntry,
  RemoteProjectEntry,
} from '../../../types/remoteSessions';

/**
 * Controller "Unknown project" self-heal.
 *
 * A live index-change for a session created on the host after the last full
 * fetch carries no projectId, so it lands under the empty-projectId ("Unknown")
 * group. applyRemoteIndexChangeAtom must SIGNAL that insert (return true) so the
 * listener can re-fetch the full index; a full fetch (setRemoteIndexAtom) then
 * carries the projectId and moves the session into its real project group.
 */
function sessionEntry(
  sessionId: string,
  projectId: string,
  over: Partial<RemoteSessionIndexEntry> = {},
): RemoteSessionIndexEntry {
  return {
    sessionId,
    projectId,
    title: `Session ${sessionId}`,
    provider: 'claude-code',
    messageCount: 0,
    lastMessageAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function projectEntry(projectId: string, name: string): RemoteProjectEntry {
  return { projectId, name, sessionCount: 1, lastActivityAt: 1, syncEnabled: true };
}

describe('remote index self-heal', () => {
  it('returns true when inserting an unknown session, false when updating a known one', () => {
    const store = createStore();
    store.set(remoteSessionsAtom, [sessionEntry('known', '/repo/app')]);

    const unknownChange: RemoteIndexChangeEntry = { sessionId: 'brand-new', title: 'New test setup' };
    const insertedUnknown = store.set(applyRemoteIndexChangeAtom, unknownChange);
    expect(insertedUnknown).toBe(true);

    const knownChange: RemoteIndexChangeEntry = { sessionId: 'known', title: 'Renamed' };
    const insertedKnown = store.set(applyRemoteIndexChangeAtom, knownChange);
    expect(insertedKnown).toBe(false);
  });

  it('lands the unknown session under the empty-projectId group, then a full fetch regroups it', () => {
    const store = createStore();
    store.set(remoteSessionsAtom, [sessionEntry('s1', '/repo/app')]);

    // Live change for a session we've never seen -> orphaned under ''.
    store.set(applyRemoteIndexChangeAtom, { sessionId: 's2', title: 'New test setup' });
    let groups = store.get(remoteSessionsByProjectAtom);
    expect(groups.get('')?.map((s) => s.sessionId)).toEqual(['s2']);
    expect(groups.get('/repo/app')?.map((s) => s.sessionId)).toEqual(['s1']);

    // The self-heal: a full index re-fetch carries the projectId for s2.
    store.set(setRemoteIndexAtom, {
      sessions: [sessionEntry('s1', '/repo/app'), sessionEntry('s2', '/repo/app', { title: 'New test setup' })],
      projects: [projectEntry('/repo/app', 'app')],
    });
    groups = store.get(remoteSessionsByProjectAtom);
    expect(groups.has('')).toBe(false);
    expect(groups.get('/repo/app')?.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
  });
});

/**
 * An unanswered prompt is re-delivered on EVERY sync_response, because the
 * host's client metadata still carries it and CollabV3Sync replays it to the
 * listeners (so a device that joined late still sees it). The transcript view
 * polls resync on a 4s interval, so a freshly-parsed — but identical — payload
 * lands every 4 seconds for as long as the question goes unanswered. Storing it
 * unconditionally re-renders the whole transcript pane on that interval and
 * rebuilds the answer widget under the user's cursor. Only a real change may
 * reach the atom.
 */
describe('pending prompt churn', () => {
  const question = (): RemotePendingPromptData => ({
    promptType: 'ask_user_question',
    questionId: 'q1',
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'Rewrite', description: 'Start over' },
          { label: 'Patch', description: 'Minimal change' },
        ],
        multiSelect: false,
      },
    ],
  });

  it('ignores a re-delivery of the identical prompt', () => {
    const store = createStore();
    const atom = remotePendingPromptAtomFamily('s1');

    store.set(setRemotePendingPromptAtom, { sessionId: 's1', data: question() });
    const first = store.get(atom);

    // Same prompt, freshly parsed off the wire — must not become a new value.
    store.set(setRemotePendingPromptAtom, { sessionId: 's1', data: question() });
    expect(store.get(atom)).toBe(first);
  });

  it('still applies a changed prompt and a clear', () => {
    const store = createStore();
    const atom = remotePendingPromptAtomFamily('s2');

    store.set(setRemotePendingPromptAtom, { sessionId: 's2', data: question() });
    const asked = { ...question(), questionId: 'q2' } as RemotePendingPromptData;
    store.set(setRemotePendingPromptAtom, { sessionId: 's2', data: asked });
    expect(store.get(atom)).toEqual(asked);

    // Answering clears it — `null` must win over the stored object.
    store.set(setRemotePendingPromptAtom, { sessionId: 's2', data: null });
    expect(store.get(atom)).toBeNull();
  });
});
