// Exports `EIDOVERSE_PORT` (8940) and `EIDOVERSE_PROCESS_NAME`, the managed Eidoverse Worlds identity, as
// a dependency-free leaf that avoids importing the heavy eidoverse service.
//
// A leaf (#8901) so `managedVisitorHost.js` and the Bun preload
// (`eidoverseLoopbackPreload.js`) can read it without pulling in the
// `services/eidoverse.js` graph (os/path/spawn/git/apps). `services/eidoverse.js`
// re-exports these rather than declaring copies, so they never drift.
export const EIDOVERSE_PORT = 8940;
export const EIDOVERSE_PROCESS_NAME = 'eidoverse-worlds';
