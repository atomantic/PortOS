import { fileURLToPath } from 'node:url';

export const VITEST_WATCH_OPTIONS = {
  // Native macOS fsevents can reach idle without delivering config edits (#13103).
  useFsEvents: false,
  // Anchor to THIS checkout: **/data/** would also ignore claim-worktree source.
  ignored: [fileURLToPath(new URL('../../data/', import.meta.url)).replaceAll('\\', '/') + '**'],
};
