/**
 * Resolve which interactive prompt the controller should render for a session.
 *
 * There are two independent sources, because the host surfaces prompts two
 * different ways:
 *
 *  1. The projected transcript — sessions that write the prompt into the message
 *     stream (the CLI path) carry it as an `interactive_prompt` view message.
 *  2. Session metadata synced by the host (`pendingPromptData`) — the ONLY way
 *     SDK tool-permissions and SDK AskUserQuestion prompts reach a remote
 *     device, since those are never persisted to the transcript.
 *
 * The transcript wins when both are present: it carries the resolved status, so
 * an answered prompt stops rendering even if a `pendingPromptData` clear was
 * dropped.
 */

import type {
  PermissionRequestContent,
  AskUserQuestionRequestContent,
} from '@nimbalyst/runtime/ai/server/types';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import type { RemotePendingPromptData } from '../../store/atoms/remoteSessions';

/** A commit the agent wants to make, rendered by the controller's own widget. */
export interface CommitProposalContent {
  proposalId: string;
  commitMessage: string;
  filesToStage: string[];
  reasoning?: string;
}

/** The pending interactive prompt currently awaiting a response, if any. */
export type PendingPrompt =
  | { promptType: 'permission_request'; content: PermissionRequestContent }
  | { promptType: 'ask_user_question_request'; content: AskUserQuestionRequestContent }
  | { promptType: 'git_commit_proposal'; content: CommitProposalContent }
  | null;

/**
 * Find a pending interactive prompt in the PROJECTED transcript. The projector
 * surfaces a provider-agnostic `interactivePrompt` payload on
 * `interactive_prompt` view messages (with requestId/status), which is the same
 * representation the desktop widgets use — and it works regardless of whether
 * the prompt came from a persisted `permission_request` message or a synthetic
 * ToolPermission tool_use. Returns the most recent still-pending request.
 */
export function findPendingPrompt(viewMessages: TranscriptViewMessage[]): PendingPrompt {
  for (let i = viewMessages.length - 1; i >= 0; i--) {
    const vm = viewMessages[i];
    const p = vm.interactivePrompt;
    if (vm.type !== 'interactive_prompt' || !p || p.status !== 'pending') continue;

    if (p.promptType === 'permission_request') {
      return {
        promptType: 'permission_request',
        content: {
          type: 'permission_request',
          requestId: p.requestId,
          toolName: p.toolName,
          rawCommand: p.rawCommand,
          pattern: p.pattern,
          patternDisplayName: p.patternDisplayName,
          isDestructive: p.isDestructive,
          warnings: p.warnings,
          timestamp: 0,
          status: p.status,
        },
      };
    }
    if (p.promptType === 'ask_user_question') {
      return {
        promptType: 'ask_user_question_request',
        content: {
          type: 'ask_user_question_request',
          questionId: p.requestId,
          questions: p.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? '' })),
            multiSelect: q.multiSelect ?? false,
          })),
          timestamp: 0,
          status: p.status,
        },
      };
    }
    if (p.promptType === 'git_commit_proposal') {
      return {
        promptType: 'git_commit_proposal',
        content: {
          proposalId: p.requestId,
          commitMessage: p.commitMessage,
          filesToStage: p.stagedFiles ?? [],
        },
      };
    }
  }
  return null;
}

/** Convert the host's synced `pendingPromptData` payload into a renderable prompt. */
export function syncedPendingToPrompt(synced: RemotePendingPromptData): PendingPrompt {
  if (!synced) return null;
  if (synced.promptType === 'permission_request') {
    return {
      promptType: 'permission_request',
      content: {
        type: 'permission_request',
        requestId: synced.requestId,
        toolName: synced.toolName,
        rawCommand: synced.rawCommand,
        pattern: synced.pattern,
        patternDisplayName: synced.patternDisplayName,
        isDestructive: synced.isDestructive,
        warnings: synced.warnings,
        timestamp: 0,
        status: 'pending',
      },
    };
  }
  if (synced.promptType === 'git_commit_proposal') {
    return {
      promptType: 'git_commit_proposal',
      content: {
        proposalId: synced.proposalId,
        commitMessage: synced.commitMessage,
        filesToStage: synced.filesToStage ?? [],
        reasoning: synced.reasoning,
      },
    };
  }
  // A question with no options can't be answered from the controller's widget,
  // so treat it as nothing pending rather than rendering a dead prompt.
  const questions = synced.questions.filter((q) => q.options.length > 0);
  if (questions.length === 0) return null;
  return {
    promptType: 'ask_user_question_request',
    content: {
      type: 'ask_user_question_request',
      questionId: synced.questionId,
      questions,
      timestamp: 0,
      status: 'pending',
    },
  };
}

/** The prompt to render: transcript first, then the host's synced payload. */
export function resolvePendingPrompt(
  viewMessages: TranscriptViewMessage[],
  synced: RemotePendingPromptData,
): PendingPrompt {
  return findPendingPrompt(viewMessages) ?? syncedPendingToPrompt(synced);
}
