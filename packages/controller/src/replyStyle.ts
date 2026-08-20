/**
 * Reply-style persistence for the standalone controller.
 *
 * The style itself lives in the runtime so every controller shares one wording;
 * only where it is stored differs. Same localStorage rationale as config.ts.
 */
export {
  applyReplyStyle,
  isReplyStyle,
  nextReplyStyle,
  REPLY_STYLES,
  REPLY_STYLE_LABELS,
  type ReplyStyle,
} from '@nimbalyst/runtime/ai/prompts/replyStyle';

import { isReplyStyle, type ReplyStyle } from '@nimbalyst/runtime/ai/prompts/replyStyle';

const STORAGE_KEY = 'nimbalyst.controller.replyStyle';

/** Reads the persisted style. Same localStorage rationale as config.ts. */
export function loadReplyStyle(): ReplyStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isReplyStyle(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function saveReplyStyle(style: ReplyStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    /* a storage-less browser still gets the in-memory toggle */
  }
}
