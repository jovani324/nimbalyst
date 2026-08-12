/**
 * Images pasted into the new-session dialog can't ride on the create request —
 * that payload is text-only — so the dialog has to create the session bare and
 * follow up with a prompt control message carrying the bytes. A regression here
 * silently drops the attachment (the session is created, the image never lands).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewRemoteSessionDialog } from '../NewRemoteSessionDialog';

vi.mock('../controllerImages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../controllerImages')>()),
  // Canvas/createImageBitmap don't exist in jsdom; the shrink path has its own tests.
  prepareImage: vi.fn(async (file: File) => ({
    id: 'img-1',
    name: file.name,
    mimeType: 'image/png',
    data: 'BASE64',
    size: 1024,
    previewUrl: 'data:image/png;base64,BASE64',
  })),
}));

const projects = [
  { projectId: 'p1', name: 'Project One', sessionCount: 0, lastActivityAt: 0, syncEnabled: true },
];

function pasteImage(el: HTMLElement) {
  const file = new File(['x'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(el, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
    },
  });
}

describe('NewRemoteSessionDialog image attachments', () => {
  let create: ReturnType<typeof vi.fn>;
  let sendPrompt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    create = vi.fn(async () => ({ success: true, sessionId: 's1' }));
    sendPrompt = vi.fn(async () => ({ success: true, promptId: 'q1' }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remoteSessions: { create, sendPrompt },
    };
  });

  it('creates the session bare and sends the pasted image with the prompt', async () => {
    const onCreated = vi.fn();
    render(<NewRemoteSessionDialog projects={projects} onClose={vi.fn()} onCreated={onCreated} />);

    const prompt = screen.getByTestId('remote-new-session-prompt');
    fireEvent.change(prompt, { target: { value: 'look at this' } });
    pasteImage(prompt);
    await screen.findByTestId('remote-session-composer-images');

    fireEvent.click(screen.getByTestId('remote-new-session-create'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('s1'));
    // The prompt text must NOT double up as initialPrompt — the host would run it twice.
    expect(create).toHaveBeenCalledWith({ projectId: 'p1', initialPrompt: undefined });
    expect(sendPrompt).toHaveBeenCalledWith('s1', 'look at this', [
      { name: 'shot.png', mimeType: 'image/png', data: 'BASE64' },
    ]);
  });

  it('still creates with an initial prompt when nothing is attached', async () => {
    render(<NewRemoteSessionDialog projects={projects} onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByTestId('remote-new-session-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('remote-new-session-create'));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId: 'p1', initialPrompt: 'go' }));
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('sends a stand-in prompt when the image arrives with no words', async () => {
    render(<NewRemoteSessionDialog projects={projects} onClose={vi.fn()} onCreated={vi.fn()} />);
    pasteImage(screen.getByTestId('remote-new-session-prompt'));
    await screen.findByTestId('remote-session-composer-images');

    fireEvent.click(screen.getByTestId('remote-new-session-create'));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith('s1', 'Take a look at this image.', expect.any(Array)),
    );
  });
});
