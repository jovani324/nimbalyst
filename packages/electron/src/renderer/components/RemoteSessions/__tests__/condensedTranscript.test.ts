// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import {
  linkify,
  parseFileRef,
  toCondensedBlocks,
  summarizeAssistant,
  toolChipLabel,
  summarizeToolGroup,
  toolGroupHasError,
  buildSessionMarkdown,
} from '../condensedTranscript';

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

  it('drops empty-text prose turns (the "(no text)" clutter)', () => {
    const blocks = toCondensedBlocks([
      msg({ type: 'assistant_message', text: '' }),
      msg({ type: 'assistant_message', text: '   ' }),
      msg({ type: 'user_message', text: 'still here' }),
      msg({ type: 'assistant_message', text: 'reply' }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === 'message')).toBe(true);
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

describe('linkify', () => {
  it('splits a bare URL out of surrounding prose', () => {
    expect(linkify('see https://example.com/a_b for details')).toEqual([
      'see ',
      { kind: 'url', href: 'https://example.com/a_b', key: expect.any(String) },
      ' for details',
    ]);
  });

  it('leaves sentence punctuation outside the link', () => {
    // A trailing period swallowed into the href produces a 404 on click.
    const parts = linkify('go to https://example.com/docs.');
    expect(parts[1]).toMatchObject({ href: 'https://example.com/docs' });
    expect(parts[2]).toBe('.');
  });

  it('returns plain text untouched', () => {
    expect(linkify('no links here')).toEqual(['no links here']);
  });

  it('pulls out a file reference with its line number', () => {
    expect(linkify('fixed in src/main/index.ts:42 today')).toEqual([
      'fixed in ',
      { kind: 'file', path: 'src/main/index.ts', line: 42, text: 'src/main/index.ts:42', key: expect.any(String) },
      ' today',
    ]);
  });

  it('does not turn a bare domain or a version into a file', () => {
    // The whole point of the extension whitelist: a dead "open example.com"
    // link is worse than leaving the text alone.
    expect(linkify('example.com shipped v1.2 and up')).toEqual(['example.com shipped v1.2 and up']);
  });

  it('does not eat a path that lives inside a URL', () => {
    const parts = linkify('https://example.com/a/b/index.ts:4');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'url' });
  });
});

describe('parseFileRef', () => {
  it('reads a path and line out of an inline-code token', () => {
    expect(parseFileRef(' packages/electron/src/a.tsx:12:3 ')).toEqual({
      path: 'packages/electron/src/a.tsx',
      line: 12,
    });
  });

  it('rejects prose and unknown extensions', () => {
    expect(parseFileRef('run the tests')).toBeNull();
    expect(parseFileRef('report.docx')).toBeNull();
  });

  it('marks a picture and drops the @ an attachment mention wears', () => {
    // The @ is transcript decoration; the staged file on the host has none.
    expect(parseFileRef('@shot.png')).toEqual({ path: 'shot.png', isImage: true });
    expect(parseFileRef('docs/diagram.jpeg')).toEqual({ path: 'docs/diagram.jpeg', isImage: true });
  });
});

describe('linkify image refs', () => {
  it('flags a picture so the click goes to the default app, not the viewer', () => {
    expect(linkify('see @shot.png here')).toEqual([
      'see ',
      { kind: 'file', path: 'shot.png', isImage: true, text: '@shot.png', key: expect.any(String) },
      ' here',
    ]);
  });
});
