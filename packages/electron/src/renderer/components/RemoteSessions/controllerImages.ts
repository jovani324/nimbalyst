/**
 * Prepare a pasted/dropped image for the trip to the host.
 *
 * Unlike the desktop composer — which hands the file to a local
 * `attachment:save` IPC and only ever moves a filepath around — the controller
 * is a different machine, so the bytes themselves have to travel over the sync
 * relay inside a session-control message. A raw retina screenshot is several MB,
 * which is a bad thing to push through a websocket, so images are downscaled to
 * a sane edge and re-encoded before sending. The host re-compresses and stores
 * them properly (AttachmentService) once they land.
 */

/** Longest edge kept, in px. Matches what the vision models actually consume. */
export const MAX_IMAGE_EDGE = 1568;

/** Above this, re-encode even when the pixel dimensions are already fine. */
export const SOFT_BYTE_LIMIT = 600 * 1024;

/** Hard ceiling for what we'll put on the wire, after downscaling. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** An image staged in the composer, ready to send to the host. */
export interface ControllerImage {
  id: string;
  name: string;
  mimeType: string;
  /** base64 payload, no `data:` prefix. */
  data: string;
  /** Bytes on the wire (decoded). */
  size: number;
  /** `data:` URL for the composer thumbnail. */
  previewUrl: string;
}

/** The wire shape sent to the host inside the `prompt` control message. */
export interface ControllerImagePayload {
  name: string;
  mimeType: string;
  data: string;
}

/**
 * Clipboard images all arrive named "image.png", which would collide in the
 * host's attachment directory and read as one file in the transcript.
 */
export function pastedImageName(mimeType: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  return `pasted-image-${stamp}.${ext}`;
}

/** Scale factor that fits an image inside MAX_IMAGE_EDGE (never upscales). */
export function fitScale(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  return Math.min(1, maxEdge / longest);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(',');
  return comma === -1 ? '' : dataUrl.slice(comma + 1);
}

/**
 * Downscale + re-encode when the image is large; pass it through untouched when
 * it is already small enough that re-encoding would only lose quality.
 */
async function shrink(file: Blob): Promise<{ blob: Blob; mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = fitScale(bitmap.width, bitmap.height);
    if (scale >= 1 && file.size <= SOFT_BYTE_LIMIT) {
      return { blob: file, mimeType: file.type || 'image/png' };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, mimeType: file.type || 'image/png' };
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    // A failed encode is not worth failing the paste over — send the original.
    if (!encoded) return { blob: file, mimeType: file.type || 'image/png' };
    return { blob: encoded, mimeType: 'image/jpeg' };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Turn a pasted/dropped file into a staged composer image.
 * Throws when the image is still too big to put on the relay after shrinking.
 */
export async function prepareImage(file: File, now = new Date()): Promise<ControllerImage> {
  const { blob, mimeType } = await shrink(file);
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is too large to send (${Math.round(blob.size / 1024 / 1024)}MB after shrinking)`,
    );
  }
  const data = await blobToBase64(blob);
  const name = file.name && file.name !== 'image.png' ? file.name : pastedImageName(mimeType, now);
  return {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    mimeType,
    data,
    size: blob.size,
    previewUrl: `data:${mimeType};base64,${data}`,
  };
}

/** Strip the preview/bookkeeping fields down to what the host needs. */
export function toPayload(images: ControllerImage[]): ControllerImagePayload[] {
  return images.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
}
