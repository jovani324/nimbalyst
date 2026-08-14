/**
 * Shared types for the controller-mode "Remote Sessions" feature.
 *
 * These mirror the decrypted shapes returned by the sync provider's fetchIndex()
 * and onIndexChange() (packages/runtime/src/sync/types.ts) — the same data the
 * mobile app consumes. Kept here so the preload types (electron.d.ts), the
 * renderer atoms/listener, and the view all agree on one contract.
 */

/** A session as it appears in the decrypted index list. */
export interface RemoteSessionIndexEntry {
  sessionId: string;
  projectId: string;
  title: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  sessionType?: string;
  parentSessionId?: string;
  worktreeId?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  messageCount: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
  /** An interactive prompt (question, permission, plan) is waiting for an answer. */
  hasPendingPrompt?: boolean;
}

/** A project as it appears in the decrypted index list. */
export interface RemoteProjectEntry {
  projectId: string;
  name: string;
  sessionCount: number;
  lastActivityAt: number;
  syncEnabled: boolean;
  gitRemoteHash?: string;
}

/** Full decrypted index (result of fetchIndex). */
export interface RemoteSessionIndexList {
  sessions: RemoteSessionIndexEntry[];
  projects: RemoteProjectEntry[];
}

/** Partial index entry broadcast on a live index change (onIndexChange). */
export interface RemoteIndexChangeEntry {
  sessionId: string;
  title?: string;
  provider?: string;
  model?: string;
  mode?: 'agent' | 'planning';
  messageCount?: number;
  updatedAt?: number;
  lastMessageAt?: number;
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
  hasPendingPrompt?: boolean;
  lastReadAt?: number;
  queuedPromptCount?: number;
  draftInput?: string;
  draftUpdatedAt?: number;
}

/** A raw synced agent message (mirrors runtime AgentMessage), as delivered by a transcript change. */
export interface RemoteAgentMessage {
  id?: number;
  sessionId: string;
  createdAt?: string | Date;
  source: string;
  direction: 'input' | 'output';
  content: string;
  metadata?: Record<string, unknown>;
  hidden?: boolean;
  providerMessageId?: string;
}

/** A transcript change for a connected session (mirrors runtime SessionChange). */
export type RemoteSessionChange =
  | { type: 'message_added'; message: RemoteAgentMessage }
  | { type: 'metadata_updated'; metadata: Record<string, unknown> }
  | { type: 'session_deleted' };

/**
 * An image the controller sends along with a prompt. The bytes travel to the
 * host (base64, no `data:` prefix), which stages them as real attachments —
 * a filepath would be meaningless across machines.
 */
export interface RemotePromptImage {
  name: string;
  mimeType: string;
  data: string;
}

/** Response to a create-session request. */
export interface RemoteCreateResponse {
  requestId: string;
  success: boolean;
  sessionId?: string;
  error?: string;
}

/** Payload for answering an interactive prompt (see MobileSessionControlHandler). */
export interface RemotePromptResponsePayload {
  promptType:
    | 'ask_user_question'
    | 'exit_plan_mode'
    | 'tool_permission'
    | 'git_commit'
    | 'request_user_input';
  promptId: string;
  response: Record<string, unknown>;
}

/** Response to a worktree-create request (host cuts branch + session). */
export interface RemoteWorktreeResponse {
  requestId: string;
  success: boolean;
  error?: string;
  sessionId?: string;
  worktreeId?: string;
  branch?: string;
}

/** Output or lifecycle news from a shell the host opened for this controller. */
export interface RemoteTerminalEvent {
  sessionId: string;
  /** terminal_output | terminal_ready | terminal_exit | terminal_error */
  type: string;
  payload: {
    terminalId?: string;
    data?: string;
    cwd?: string;
    shell?: string;
    error?: string;
    exitCode?: number;
    reason?: string;
  };
}
