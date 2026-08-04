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

/**
 * NIM-2208: session ids whose bit this process has set since startup.
 *
 * The stale-prompt reconcile needs the (normally empty) set of sessions carrying
 * the bit. Reading it back from the DB meant a `SELECT id, metadata FROM
 * ai_sessions` scan over every session row — 5k+ on a working install — on every
 * pass. This function is the single writer of the bit, and the startup sweep
 * clears every row before anything can set one, so an in-memory mirror is
 * authoritative for the running process and costs no query at all.
 */
const sessionsWithPendingPrompt = new Set<string>();

/** Sessions currently carrying a pending-prompt bit set by this process. */
export function getSessionsWithPendingPrompt(): string[] {
  return [...sessionsWithPendingPrompt];
}

/** Reset the mirror; called by the startup sweep once every row is cleared. */
export function resetPendingPromptTracking(): void {
  sessionsWithPendingPrompt.clear();
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
    if (hasPendingPrompt) {
      sessionsWithPendingPrompt.add(sessionId);
    } else {
      sessionsWithPendingPrompt.delete(sessionId);
    }
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
