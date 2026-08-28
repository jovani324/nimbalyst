// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toParagraphs, TEXT_CLEANERS } from '../textSoapDocument';

function msg(partial: Partial<TranscriptViewMessage> & { type: TranscriptViewMessage['type'] }): TranscriptViewMessage {
  return { id: 1, sequence: 1, createdAt: new Date(0), subagentId: null, ...partial } as TranscriptViewMessage;
}

function tool(name: string): TranscriptViewMessage {
  return msg({
    type: 'tool_call',
    toolCall: {
      toolName: name.toLowerCase(),
      toolDisplayName: name,
      status: 'completed',
      description: null,
      arguments: {},
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: null,
      progress: [],
      isError: false,
    },
  } as Partial<TranscriptViewMessage> & { type: TranscriptViewMessage['type'] });
}

describe('toParagraphs', () => {
  it('maps turns to prose paragraphs, folds tools to an aside, and drops noise', () => {
    const paras = toParagraphs([
      msg({ type: 'user_message', text: 'lock down writes' }),
      msg({ type: 'assistant_message', text: 'enforcing via grants' }),
      tool('Read'),
      tool('Edit'),
      msg({ type: 'system_message', text: 'ignored' }),
      msg({ type: 'interactive_prompt' }),
      msg({ type: 'assistant_message', text: '   ' }), // empty prose, dropped
    ]);
    expect(paras.map((p) => p.kind)).toEqual(['you', 'assistant', 'aside']);
    expect(paras[0].text).toBe('lock down writes');
    // consecutive tool calls collapse into a single aside line
    expect(paras[2].kind).toBe('aside');
  });
});

describe('TEXT_CLEANERS', () => {
  it('Remove Extra Spaces collapses runs of whitespace', () => {
    const cleaner = TEXT_CLEANERS.find((c) => c.label === 'Remove Extra Spaces')!;
    expect(cleaner.run('a    b  c')).toBe('a b c');
  });
});
