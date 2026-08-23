// path-browserify ships no types; the shim only needs the Node `path` surface.
declare module 'path-browserify' {
  import type { PlatformPath } from 'path';
  const path: PlatformPath;
  export = path;
}
