/**
 * Reply-style persistence for the Electron controller popover.
 *
 * The style and its wording live in the runtime so all three controllers share
 * one directive; only storage differs. Here that is app-settings, never
 * localStorage — same rule and same shape as controllerAppearance.
 */
import { useCallback, useEffect, useState } from 'react';
import { isReplyStyle, type ReplyStyle } from '@nimbalyst/runtime/ai/prompts/replyStyle';

export {
  applyReplyStyle,
  nextReplyStyle,
  stripReplyStyle,
  REPLY_STYLES,
  REPLY_STYLE_LABELS,
  type ReplyStyle,
} from '@nimbalyst/runtime/ai/prompts/replyStyle';

const KEY = 'controllerReplyStyle';

/** Persisted style plus a setter. Falls back to 'default' on anything unreadable. */
export function useControllerReplyStyle(): {
  replyStyle: ReplyStyle;
  setReplyStyle: (style: ReplyStyle) => void;
} {
  const [replyStyle, setStyle] = useState<ReplyStyle>('default');

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const stored = await window.electronAPI?.invoke?.('app-settings:get', KEY);
        if (live && isReplyStyle(stored)) setStyle(stored);
      } catch {
        /* the in-memory default is a fine answer */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const setReplyStyle = useCallback((style: ReplyStyle) => {
    setStyle(style);
    void window.electronAPI?.invoke?.('app-settings:set', KEY, style)?.catch?.(() => {
      /* non-fatal */
    });
  }, []);

  return { replyStyle, setReplyStyle };
}
