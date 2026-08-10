/**
 * Browser stand-in for Node's `path`, aliased in `vite.config.ts`.
 *
 * The transcript parsers are written for the host, where `path` is real:
 * `ClaudeCodeRawParser` calls `stagedAttachmentRegistry.find()` on every Read
 * tool result, and that calls `path.resolve`. Without this, Vite externalizes
 * `path` and the first transcript containing a file read throws.
 *
 * `path-browserify` alone is not enough — its `resolve` falls back to
 * `process.cwd()` when no argument is absolute, and there is no `process` here.
 * Rooting at '/' is a no-op for the absolute paths tool results normally carry
 * and keeps a relative one from crashing the render.
 */
import browserPath from 'path-browserify';

const resolve = (...segments: string[]): string => browserPath.resolve('/', ...segments);

const shim = { ...browserPath, resolve };

export const { basename, dirname, extname, join, normalize, relative, sep } = browserPath;
export { resolve };
export default shim;
