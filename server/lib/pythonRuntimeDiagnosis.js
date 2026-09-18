/**
 * Map Python setup/exec output onto a fixed operator-facing diagnosis.
 *
 * Every managed Python runtime in PortOS (Prompt Guard, jev, and any future
 * pinned-model boundary) hits the same short list of real-world failures: a
 * missing module, a broken certificate chain, no wheel for this platform, an
 * unsolvable resolution, a full disk, an unreachable index. Each one needs a
 * DIFFERENT operator action, so a single "install failed" is useless.
 *
 * The evidence is raw pip/interpreter output, which can carry an authenticated
 * package-index URL, a private path, or a token — so it is matched against
 * static patterns and DISCARDED. Nothing from `text` is ever returned.
 *
 * Pure: no I/O, no process state.
 */

const EVIDENCE = [
  [/No module named/, 'package-missing', (subject) => `A ${subject} package or dependency is missing.`, 'repair-packages'],
  [/CERTIFICATE_VERIFY_FAILED|certificate verify failed/i, 'certificate-failed', () => 'Python could not verify the package server certificate.', 'Repair Python certificate trust, then retry installation.'],
  [/No matching distribution|Could not find a version that satisfies/i, 'wheel-unavailable', () => 'A pinned package has no matching distribution for this Python and platform.', 'Use a Python version and platform supported by the pinned packages, then repair the runtime.'],
  [/ResolutionImpossible|conflicting dependencies/i, 'dependency-conflict', (subject) => `The ${subject} dependencies could not be resolved.`, 'Check the pinned package compatibility before retrying.'],
  [/No space left on device/i, 'disk-full', (subject) => `There is not enough disk space for the ${subject}.`, 'Free disk space, then retry installation.'],
  [/timed? ?out|ReadTimeout|ConnectionError|NameResolution|Temporary failure|Network is unreachable|No route to host|connection error|NewConnectionError/i, 'network-failed', () => 'The download could not reach its server.', 'Check this machine’s network and Python connection to the download server, then retry.'],
];

/**
 * @param text    Raw subprocess output. Read for evidence, never returned.
 * @param subject The noun for this runtime's packages ("classifier", "scorer").
 * @param repairLabel What the operator repairs, as the UI names it
 *                    ("model-abuse guard", "jev"). Completes both repair actions.
 * @param imports The pinned import names, so a named missing module can be
 *                reported precisely rather than as "a package".
 * @param fallback The code to use when no pattern matches.
 */
export function diagnosePythonRuntimeText(text, {
  subject = 'runtime',
  repairLabel = 'the runtime',
  imports = [],
  fallback = 'runtime-check-failed',
} = {}) {
  const evidence = String(text || '');
  const repairPackages = `Repair ${repairLabel} to install the pinned packages.`;
  const action = (value) => (value === 'repair-packages' ? repairPackages : value);

  // A named module beats the generic "No module named" row: it tells the
  // operator WHICH pinned package did not survive, which is the difference
  // between a repair and a bug report.
  const missing = imports.find((name) => evidence.includes(`No module named '${name}'`));
  if (missing) {
    return {
      code: 'package-missing',
      package: missing,
      message: `The ${subject} package ${missing} is missing.`,
      action: repairPackages,
    };
  }

  const match = EVIDENCE.find(([pattern]) => pattern.test(evidence));
  if (match) return { code: match[1], message: match[2](subject), action: action(match[3]) };
  return {
    code: fallback,
    message: `The dedicated ${subject} runtime could not be verified.`,
    action: `Repair ${repairLabel} and inspect the reported install stage and exit code.`,
  };
}
