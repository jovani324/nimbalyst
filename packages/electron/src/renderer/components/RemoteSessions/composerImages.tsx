/**
 * Shared image-paste plumbing for the controller's two composers: the reply box
 * on an open session, and the initial prompt in the new-session dialog. Both
 * stage images the same way (see controllerImages.ts for the shrink/encode
 * rules) and both ship them to the host on the prompt control message.
 */

import { useCallback, useState, type ClipboardEvent } from 'react';
import { prepareImage, type ControllerImage } from './controllerImages';

export interface ComposerImages {
  images: ControllerImage[];
  /** How many pastes are still being shrunk/encoded. */
  preparing: number;
  /** The last paste failure, if any. */
  error: string | null;
  clearError: () => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => Promise<void>;
  remove: (id: string) => void;
  clear: () => void;
}

/** Stage images pasted into a textarea, ready to ride along with the prompt. */
export function useComposerImages(): ComposerImages {
  const [images, setImages] = useState<ControllerImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handlePaste = useCallback(async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    setError(null);
    setPreparing((n) => n + files.length);
    for (const file of files) {
      try {
        const image = await prepareImage(file);
        setImages((prev) => [...prev, image]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to attach image');
      } finally {
        setPreparing((n) => Math.max(0, n - 1));
      }
    }
  }, []);

  return {
    images,
    preparing,
    error,
    clearError: useCallback(() => setError(null), []),
    handlePaste,
    remove: useCallback((id: string) => setImages((prev) => prev.filter((i) => i.id !== id)), []),
    clear: useCallback(() => setImages([]), []),
  };
}

/** Thumbnail strip for staged images; renders nothing when there are none. */
export function ComposerImageStrip({ images, preparing, remove }: ComposerImages) {
  if (images.length === 0 && preparing === 0) return null;
  return (
    <div
      className="remote-session-composer-images flex items-center gap-2 flex-wrap"
      data-testid="remote-session-composer-images"
    >
      {images.map((image) => (
        <div
          key={image.id}
          className="remote-session-composer-image relative rounded overflow-hidden"
          style={{ border: '1px solid var(--nim-border)' }}
          title={`${image.name} · ${Math.max(1, Math.round(image.size / 1024))}KB`}
        >
          <img src={image.previewUrl} alt={image.name} style={{ height: 44, width: 'auto', display: 'block' }} />
          <button
            className="remote-session-composer-image-remove absolute top-0 right-0 leading-none px-1"
            style={{ background: 'var(--nim-bg)', color: 'var(--nim-text-muted)', fontSize: 11 }}
            onClick={() => remove(image.id)}
            title="Remove image"
            aria-label={`Remove ${image.name}`}
          >
            ×
          </button>
        </div>
      ))}
      {preparing > 0 && (
        <span className="text-xs" style={{ color: 'var(--nim-text-muted)' }}>
          preparing image…
        </span>
      )}
    </div>
  );
}
