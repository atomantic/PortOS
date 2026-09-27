// Canonical Eidoverse Worlds HTTP port, a dependency-free leaf so
// `managedVisitorHost.js` can default to it without pulling in the heavy
// `services/eidoverse.js` graph (os/path/spawn/git/apps) it doesn't otherwise
// need (#8901). `services/eidoverse.js` re-exports this rather than declaring
// its own copy, so the two never drift.
export const EIDOVERSE_PORT = 8940;
