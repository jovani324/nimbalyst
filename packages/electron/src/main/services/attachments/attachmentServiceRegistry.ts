/**
 * Shared cache of AttachmentService instances, keyed by workspace + staging
 * config. Lives outside the IPC layer because attachments also arrive from
 * places that have no window and no renderer behind them — a controller device
 * pasting an image into a remote session, for one.
 */

import { AttachmentService } from '../AttachmentService';
import { getAttachmentStagingConfig } from '../../utils/store';
import { resolveWorkspaceAttachmentStagingDirectory } from './attachmentStagingRoot';
import { addNimAssetRoot } from '../../protocols/nimAssetProtocol';

const attachmentServices = new Map<string, AttachmentService>();

/** Get or create the AttachmentService for a workspace under the current staging config. */
export function getAttachmentService(workspacePath: string): AttachmentService {
  const config = getAttachmentStagingConfig();
  const stagingDirectory = resolveWorkspaceAttachmentStagingDirectory(workspacePath);
  const key = `${workspacePath}\0${config.mode}\0${stagingDirectory}`;
  if (!attachmentServices.has(key)) {
    addNimAssetRoot(stagingDirectory);
    attachmentServices.set(key, new AttachmentService(workspacePath, stagingDirectory, config.mode));
  }
  return attachmentServices.get(key)!;
}
