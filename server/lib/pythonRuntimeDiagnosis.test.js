import { describe, expect, it } from 'vitest';
import { diagnosePythonRuntimeText } from './pythonRuntimeDiagnosis.js';

const guard = { subject: 'classifier', repairLabel: 'model-abuse guard', imports: ['torch', 'transformers'] };

describe('diagnosePythonRuntimeText', () => {
  // The privacy guarantee this file exists for: pip output routinely carries an
  // authenticated index URL, a token, or a home-directory path, and all three
  // reach an operator-facing payload if any of it is echoed back.
  it('returns none of the evidence it matched on', () => {
    const evidence = [
      'Looking in indexes: https://user:hunter2@packages.example.com/simple',
      'WARNING: Retrying after ReadTimeout',
      'Could not install packages due to an OSError: /Users/someone/.cache/pip',
    ].join('\n');
    const result = diagnosePythonRuntimeText(evidence, guard);
    const rendered = JSON.stringify(result);
    expect(result.code).toBe('network-failed');
    for (const secret of ['hunter2', 'packages.example.com', '/Users/someone', 'ReadTimeout']) {
      expect(rendered).not.toContain(secret);
    }
  });

  // "A package is missing" and "torch is missing" are different repairs, and
  // the generic row would swallow the specific one if it were checked first.
  it('names the specific pinned import ahead of the generic missing-module row', () => {
    expect(diagnosePythonRuntimeText("ModuleNotFoundError: No module named 'torch'", guard))
      .toMatchObject({ code: 'package-missing', package: 'torch' });
    // Not a pinned import, so the generic row answers and names no package.
    const generic = diagnosePythonRuntimeText("No module named 'scipy'", guard);
    expect(generic.code).toBe('package-missing');
    expect(generic).not.toHaveProperty('package');
    expect(generic.message).not.toContain('scipy');
  });

  it.each([
    ['CERTIFICATE_VERIFY_FAILED', 'certificate-failed'],
    ['No matching distribution found for torch==2.14.0', 'wheel-unavailable'],
    ['ResolutionImpossible', 'dependency-conflict'],
    ['No space left on device', 'disk-full'],
    ['NewConnectionError', 'network-failed'],
  ])('maps %s to %s', (evidence, code) => {
    expect(diagnosePythonRuntimeText(evidence, guard).code).toBe(code);
  });

  it('falls back to the caller-supplied code for unrecognized output', () => {
    expect(diagnosePythonRuntimeText('something nobody has seen before', { ...guard, fallback: 'model-download-failed' }))
      .toMatchObject({ code: 'model-download-failed' });
    expect(diagnosePythonRuntimeText(null, guard).code).toBe('runtime-check-failed');
  });

  // Both boundaries share the table but must name themselves, or an operator is
  // pointed at the wrong repair screen.
  it('renders each boundary\'s own noun and repair label', () => {
    expect(diagnosePythonRuntimeText("No module named 'torch'", guard))
      .toMatchObject({
        message: 'The classifier package torch is missing.',
        action: 'Repair model-abuse guard to install the pinned packages.',
      });
    expect(diagnosePythonRuntimeText("No module named 'torch'", { ...guard, subject: 'scorer', repairLabel: 'jev' }))
      .toMatchObject({
        message: 'The scorer package torch is missing.',
        action: 'Repair jev to install the pinned packages.',
      });
  });
});
