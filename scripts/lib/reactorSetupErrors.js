// Exit codes are the setup subprocess's public protocol. Never forward raw
// installer output: it can contain credentials, proxy URLs and local paths.
export const REACTOR_SETUP_ERRORS = Object.freeze({
  20: 'Reactor runtime manager download failed; check access to GitHub releases and retry the render',
  21: 'Reactor runtime download failed integrity verification; retry the render',
  22: 'Reactor runtime archive extraction failed; check tar availability and disk space, then retry the render',
  23: 'Reactor Python environment preparation failed; check uv access to Python downloads on GitHub releases, proxy settings and disk space, then retry the render',
  24: 'Reactor SDK installation failed; check uv access to the configured Python package index and disk space, then retry the render',
  25: 'Reactor SDK verification failed; retry the render to repair the installation',
  26: 'Reactor runtime is not supported on this operating system/architecture',
});
