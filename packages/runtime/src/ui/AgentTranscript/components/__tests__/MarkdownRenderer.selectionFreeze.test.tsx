/**
 * Regression: selecting text in a streaming transcript message used to
 * deselect instantly, because react-markdown re-parses on every chunk and
 * replaces the DOM text nodes the browser selection is anchored to. The
 * renderer now freezes its content while a non-collapsed selection touches its
 * subtree, and flushes to the latest content once the selection clears.
 */

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as rtl from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, cleanup, act } = rtl;

function renderMessage(content: string) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <MarkdownRenderer content={content} messageId="msg-1" />
    </Provider>,
  );
}

type FakeSelection = Pick<
  Selection,
  'isCollapsed' | 'rangeCount' | 'anchorNode' | 'focusNode'
>;

function stubSelection(sel: FakeSelection): void {
  vi.spyOn(window, 'getSelection').mockReturnValue(sel as Selection);
}

const collapsed: FakeSelection = {
  isCollapsed: true,
  rangeCount: 0,
  anchorNode: null,
  focusNode: null,
};

describe('MarkdownRenderer selection freeze during streaming', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('applies streamed content immediately when nothing is selected', () => {
    stubSelection(collapsed);
    const { container, rerender } = render(
      <Provider store={createStore()}>
        <MarkdownRenderer content="First" messageId="msg-1" />
      </Provider>,
    );
    expect(container.textContent).toContain('First');

    rerender(
      <Provider store={createStore()}>
        <MarkdownRenderer content="First second" messageId="msg-1" />
      </Provider>,
    );
    expect(container.textContent).toContain('First second');
  });

  it('holds content steady while a selection is inside, then flushes on clear', () => {
    stubSelection(collapsed);
    const { container, rerender } = render(
      <Provider store={createStore()}>
        <MarkdownRenderer content="First second" messageId="msg-1" />
      </Provider>,
    );
    const textNode = container.querySelector('.markdown-content p')?.firstChild;
    expect(textNode).toBeTruthy();

    // User selects text inside the message.
    stubSelection({
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: textNode as Node,
      focusNode: textNode as Node,
    });

    // A streaming chunk arrives while the selection is held.
    rerender(
      <Provider store={createStore()}>
        <MarkdownRenderer content="First second third" messageId="msg-1" />
      </Provider>,
    );
    // Frozen: the newest word is withheld so the selected DOM nodes survive.
    expect(container.textContent).toContain('First second');
    expect(container.textContent).not.toContain('third');

    // User clears the selection -> flush to the latest streamed content.
    stubSelection(collapsed);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(container.textContent).toContain('First second third');
  });
});
