/**
 * Shared allowlist of flags PortOS may forward to a managed app's `deploy.sh`, consumed by socket
 * validation and deployment orchestration without reversing the lib/services dependency.
 */

/**
 * Flags PortOS may forward to a managed app's deploy.sh script.
 *
 * Kept below the service layer so request validation and deployment
 * orchestration share one allowlist without lib importing services.
 */
export const DEPLOY_FLAGS = Object.freeze([
  '--ios',
  '--macos',
  '--watch',
  '--all',
  '--skip-tests',
]);
