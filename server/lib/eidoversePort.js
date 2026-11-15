// Exports `EIDOVERSE_PORT` (8940), the Eidoverse Worlds HTTP port, as a dependency-free leaf that
// avoids importing the heavy eidoverse service.
//
// `EIDOVERSE_PORT` (8940) — the Eidoverse Worlds HTTP port as a dependency-free leaf (#8901), so
// `services/managedVisitorHost.js` can default to it without pulling in the heavy
// `services/eidoverse.js` graph (os/path/spawn/git/apps). `services/eidoverse.js` re-exports it rather
// than declaring its own copy.
//
// Canonical Eidoverse Worlds HTTP port, a dependency-free leaf so
// `managedVisitorHost.js` can default to it without pulling in the heavy
// `services/eidoverse.js` graph (os/path/spawn/git/apps) it doesn't otherwise
// need (#8901). `services/eidoverse.js` re-exports this rather than declaring
// its own copy, so the two never drift.
export const EIDOVERSE_PORT = 8940;
