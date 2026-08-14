// @vitest-environment node
/**
 * The terminal router sits in front of EVERY session-control message the host
 * receives, so its two answers matter more than what it does with them: claim
 * `terminal_*` (or the shell never opens) and pass on everything else (or
 * prompts, cancels and permission answers stop reaching their handlers).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sendSessionControlMessage = vi.fn(async (_message: { type: string; sentBy: string }) => {});
let terminalEnabled = true;

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ sendSessionControlMessage }) }));
vi.mock('../../utils/store', () => ({ isRemoteTerminalEnabled: () => terminalEnabled }));
vi.mock('../CLIManager', () => ({ getEnhancedPath: () => '/usr/bin' }));
vi.mock('../ShellDetector', () => ({
  ShellDetector: { getDefaultShell: () => ({ name: 'zsh', path: '/bin/zsh', args: [] }) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: async () => ({ workspacePath: '/tmp' }) },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { handleRemoteTerminalControl } = await import('../RemoteTerminalService');

describe('handleRemoteTerminalControl', () => {
  beforeEach(() => {
    terminalEnabled = true;
    sendSessionControlMessage.mockClear();
  });

  it('passes non-terminal control messages through to the other handlers', () => {
    for (const type of ['prompt', 'prompt_response', 'cancel', 'archive']) {
      expect(handleRemoteTerminalControl({ sessionId: 's1', type })).toBe(false);
    }
  });

  it('claims terminal messages', () => {
    expect(
      handleRemoteTerminalControl({ sessionId: 's1', type: 'terminal_close', payload: { terminalId: 't1' } }),
    ).toBe(true);
  });

  it('refuses to spawn anything when the host has remote terminals turned off', async () => {
    terminalEnabled = false;
    expect(
      handleRemoteTerminalControl({ sessionId: 's1', type: 'terminal_open', payload: { terminalId: 't1' } }),
    ).toBe(true);
    await vi.waitFor(() => expect(sendSessionControlMessage).toHaveBeenCalled());
    expect(sendSessionControlMessage.mock.calls[0][0]).toMatchObject({
      type: 'terminal_error',
      sentBy: 'desktop',
    });
  });

  it('ignores input for a terminal that was never opened', () => {
    expect(
      handleRemoteTerminalControl({
        sessionId: 's1',
        type: 'terminal_input',
        payload: { terminalId: 'nope', data: 'ls\n' },
      }),
    ).toBe(true);
    expect(sendSessionControlMessage).not.toHaveBeenCalled();
  });
});
