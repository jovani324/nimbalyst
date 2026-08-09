// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { resolvePendingPrompt } from '../pendingPrompt';

const question = (id: string, header: string): TranscriptViewMessage =>
  ({
    type: 'interactive_prompt',
    interactivePrompt: {
      promptType: 'ask_user_question',
      requestId: id,
      status: 'pending',
      questions: [
        {
          question: 'Which approach?',
          header,
          options: [{ label: 'A', description: 'first' }],
          multiSelect: false,
        },
      ],
    },
  }) as unknown as TranscriptViewMessage;

describe('resolvePendingPrompt', () => {
  it('renders a question the host synced through session metadata', () => {
    // SDK sessions never write the question into the transcript, so without the
    // synced payload the controller shows a running session and no way to answer.
    const prompt = resolvePendingPrompt([], {
      promptType: 'ask_user_question',
      questionId: 'q-1',
      questions: [
        {
          question: 'Ship it?',
          header: 'Release',
          options: [{ label: 'Yes', description: 'tag now' }],
          multiSelect: false,
        },
      ],
    });

    expect(prompt).toEqual({
      promptType: 'ask_user_question_request',
      content: expect.objectContaining({
        type: 'ask_user_question_request',
        questionId: 'q-1',
        status: 'pending',
        questions: [expect.objectContaining({ header: 'Release' })],
      }),
    });
  });

  it('drops a synced question with no answerable options', () => {
    expect(
      resolvePendingPrompt([], {
        promptType: 'ask_user_question',
        questionId: 'q-1',
        questions: [{ question: 'Ship it?', header: 'Release', options: [], multiSelect: false }],
      }),
    ).toBeNull();
  });

  it('prefers the transcript over the synced payload', () => {
    // The transcript carries resolution status; a stale pendingPromptData that
    // was never cleared must not resurrect an answered prompt.
    const prompt = resolvePendingPrompt([question('from-transcript', 'Transcript')], {
      promptType: 'ask_user_question',
      questionId: 'from-metadata',
      questions: [
        {
          question: 'Ship it?',
          header: 'Metadata',
          options: [{ label: 'Yes', description: '' }],
          multiSelect: false,
        },
      ],
    });

    expect(prompt?.content).toMatchObject({ questionId: 'from-transcript' });
  });

  it('returns nothing when neither source has a pending prompt', () => {
    expect(resolvePendingPrompt([], null)).toBeNull();
  });
});
