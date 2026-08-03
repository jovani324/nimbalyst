/**
 * Persist the per-session "interactive prompt is open" bit to
 * `ai_sessions.metadata.hasPendingPrompt` and push the same change to
 * connected mobile clients.
 *
 * This is the authoritative source for "Waiting for your response" sidebar
 * indicators across desktop ↔ mobile. The renderer reads it on session list
 * load via `hasPendingInteractivePrompt`, so a stuck atom from a missed
 * resolve event is healed on the next session list refresh.
 *
 * Callers: every place that opens or resolves an interactive prompt
 * (AskUserQuestion, ExitPlanMode, ToolPermission, GitCommitProposal,
 * RequestUserInput / PromptForUserInput).
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { getSyncProvider } from '../SyncManager';
import { logger } from '../../utils/logger';

/**
 * Full tool-permission payload synced to remote devices so they can render the
 * approve UI and answer it (controller / mobile). Additive; other clients ignore it.
 */
export interface SyncedPendingPromptData {
  promptType: 'permission_request';
  requestId: string;
  toolName: string;
  rawCommand: string;
  pattern: string;
  patternDisplayName: string;
  isDestructive: boolean;
  warnings: string[];
}

export async function setSessionPendingPrompt(
  sessionId: string,
  hasPendingPrompt: boolean,
  promptData?: SyncedPendingPromptData | null,
): Promise<void> {
  if (!sessionId) return;

  try {
    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: { hasPendingPrompt },
    });
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to persist hasPendingPrompt=${hasPendingPrompt} for session ${sessionId}:`,
      err,
    );
  }

  try {
    const sp = getSyncProvider();
    if (sp) {
      const metadata: Record<string, unknown> = { hasPendingPrompt, updatedAt: Date.now() };
      // Attach the full payload when given (a pending permission); clear it (null)
      // when the prompt resolves. Leave it untouched otherwise so an unrelated
      // pending-state toggle doesn't wipe a still-open prompt on the receiver.
      if (promptData !== undefined) metadata.pendingPromptData = promptData;
      else if (!hasPendingPrompt) metadata.pendingPromptData = null;
      sp.pushChange(sessionId, {
        type: 'metadata_updated',
        metadata: metadata as any,
      });
    }
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to push hasPendingPrompt sync change for session ${sessionId}:`,
      err,
    );
  }
}
