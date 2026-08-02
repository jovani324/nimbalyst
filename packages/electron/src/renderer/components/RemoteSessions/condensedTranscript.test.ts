// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  toCondensedBlocks,
  summarizeAssistant,
  toolChipLabel,
  summarizeToolGroup,
  toolGroupHasError,
  buildSessionMarkdown,
} from './condensedTranscript';

function msg(partial: Partial<TranscriptViewMessage> & { type: TranscriptViewMessage['type'] }): TranscriptViewMessage {
  return {
    id: 1,
    sequence: 1,
    createdAt: new Date(0),
    subagentId: null,
    ...partial,
  } as TranscriptViewMessage;
}

function tool(name: string, target: string | null = null, status: 'completed' | 'error' = 'completed'): TranscriptViewMessage {
  return msg({
    type: 'tool_call',
    toolCall: {
      toolName: name.toLowerCase(),
      toolDisplayName: name,
      status,
      description: null,
      arguments: {},
      targetFilePath: target,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: null,
      progress: [],
      isError: status === 'error',
    },
  });
}

describe('toCondensedBlocks', () => {
  it('folds consecutive tool calls into one group and drops noise', () => {
    const blocks = toCondensedBlocks([
      msg({ type: 'user_message', text: 'fix it' }),
      msg({ type: 'assistant_message', text: 'Working on it' }),
      tool('Read', 'a.ts'),
      tool('Edit', 'a.ts'),
      msg({ type: 'system_message', text: 'ignored' }),
      tool('Bash'),
      msg({ type: 'turn_ended' }),
      msg({ type: 'assistant_message', text: 'Done' }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['message', 'message', 'toolGroup', 'toolGroup', 'message']);
    const firstGroup = blocks[2];
    expect(firstGroup.kind === 'toolGroup' && firstGroup.tools).toHaveLength(2);
  });
});

describe('summarizeAssistant', () => {
  it('takes the first non-empty line and strips markdown', () => {
    expect(summarizeAssistant('## Found it\n\nmore detail')).toBe('Found it');
    expect(summarizeAssistant('- `null` check in **auth.ts**')).toBe('null check in auth.ts');
  });

  it('clamps long lines with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = summarizeAssistant(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty for missing/blank text', () => {
    expect(summarizeAssistant(undefined)).toBe('');
    expect(summarizeAssistant('\n  \n')).toBe('');
  });
});

describe('tool chips', () => {
  it('labels a tool with its basename target', () => {
    expect(toolChipLabel(tool('Edit', '/repo/src/auth.ts'))).toBe('Edit · auth.ts');
    expect(toolChipLabel(tool('Bash'))).toBe('Bash');
  });

  it('summarizes a group counting repeats', () => {
    expect(summarizeToolGroup([tool('Edit'), tool('Edit'), tool('Bash')])).toBe('Edit ×2, Bash');
  });

  it('flags an error anywhere in the group', () => {
    expect(toolGroupHasError([tool('Read'), tool('Bash', null, 'error')])).toBe(true);
    expect(toolGroupHasError([tool('Read'), tool('Edit')])).toBe(false);
  });
});

describe('buildSessionMarkdown', () => {
  it('renders prose in full and tool calls as terse one-liners', () => {
    const md = buildSessionMarkdown(
      [
        msg({ type: 'user_message', text: 'fix the bug' }),
        msg({ type: 'assistant_message', text: 'Found the null check.' }),
        tool('Edit', '/repo/auth.ts'),
        tool('Bash', null, 'error'),
      ],
      'Login fix',
    );
    expect(md).toContain('# Login fix');
    expect(md).toContain('## You\n\nfix the bug');
    expect(md).toContain('## Assistant\n\nFound the null check.');
    expect(md).toContain('- `Edit · auth.ts`');
    expect(md).toContain('- `Bash` [error]');
    expect(md.endsWith('\n')).toBe(true);
  });
});
