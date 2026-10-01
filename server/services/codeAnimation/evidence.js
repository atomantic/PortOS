/**
 * Measured evidence for Code Animation production stages (#9389). Pure: it
 * turns sampled renders into findings and a verdict. Nothing here calls a
 * provider; a dimension no measurement covers is reported `unverified` and can
 * never contribute to a pass.
 */

// A frozen span at least this long (or this share of the film) is a defect.
const FROZEN_MIN_SECONDS = 2;
const FROZEN_ERROR_SHARE = 0.5;
const BLANK_MEAN_LUMA = 2;
const BLANK_DEVIATION = 1;
// Frames a declared event may take to show any visual change.
const EVENT_WINDOW_BEFORE = 0.25;
const EVENT_WINDOW_AFTER = 0.75;

const round = value => Math.round(value * 1000) / 1000;

/** Longest run of consecutive samples sharing one render hash. */
function frozenSpans(samples) {
  const spans = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i += 1) {
    if (i === samples.length || samples[i].renderHash !== samples[start].renderHash) {
      if (i - 1 > start) spans.push({ fromSeconds: samples[start].t, toSeconds: samples[i - 1].t, samples: i - start });
      start = i;
    }
  }
  return spans;
}

/**
 * Findings and verified/unverified dimensions from the style-frame and pilot
 * samples. `pilot.samples` is `[{ t, renderHash, mean, deviation }]` where mean
 * and deviation are null when the film canvas could not be read back.
 */
/** `review` is the reviewer stage record when a visual reviewer pass ran; otherwise semantic-visual stays unverified. */
export function analyzeEvidence({ manifest, pilot, contract, review = null }) {
  const findings = [];
  const { durationSeconds, width, height, fps } = manifest.format;
  const add = (kind, severity, detail, extra = {}) => findings.push({ kind, severity, detail, ...extra });

  if (contract) {
    if (Math.abs(contract.durationSec - durationSeconds) > 1 / fps + 1e-9) {
      add('duration-mismatch', 'error', `The film declares ${contract.durationSec}s but the brief asks for ${durationSeconds}s.`, { measured: { declared: contract.durationSec, expected: durationSeconds } });
    }
    if (contract.width !== width || contract.height !== height) {
      add('frame-size-mismatch', 'error', `The film renders ${contract.width}x${contract.height} but the brief asks for ${width}x${height}.`, { measured: { declared: `${contract.width}x${contract.height}`, expected: `${width}x${height}` } });
    }
  }

  const samples = pilot.samples;
  const unreadable = samples.every(sample => sample.mean === null);
  if (!unreadable && samples.every(sample => sample.mean < BLANK_MEAN_LUMA || sample.deviation < BLANK_DEVIATION)) {
    add('blank-film', 'error', 'Every sampled frame is blank or a single flat color.', { measured: { maxMean: round(Math.max(...samples.map(sample => sample.mean))) } });
  }
  const distinct = new Set(samples.map(sample => sample.renderHash)).size;
  if (samples.length > 1 && distinct === 1) {
    add('frozen-film', 'error', 'Every sampled frame is pixel-identical: nothing moves.', { atSeconds: 0, measured: { samples: samples.length } });
  } else {
    for (const span of frozenSpans(samples)) {
      const length = span.toSeconds - span.fromSeconds;
      if (length >= FROZEN_MIN_SECONDS || length >= durationSeconds * FROZEN_ERROR_SHARE) {
        add('frozen-span', length >= durationSeconds * FROZEN_ERROR_SHARE ? 'error' : 'warning',
          `Nothing changes from ${span.fromSeconds}s to ${span.toSeconds}s.`, { atSeconds: span.fromSeconds, measured: span });
      }
    }
  }
  for (const event of manifest.events) {
    const near = samples.filter(sample => sample.t >= event.atSeconds - EVENT_WINDOW_BEFORE && sample.t <= event.atSeconds + EVENT_WINDOW_AFTER);
    if (near.length > 1 && new Set(near.map(sample => sample.renderHash)).size === 1) {
      add('event-without-change', 'warning', `Nothing visibly changes around the "${event.label}" event.`, { atSeconds: event.atSeconds, measured: { label: event.label, samples: near.length } });
    }
  }

  const verified = ['frame-size', 'timing', 'visual-motion'];
  if (!unreadable) verified.push('blank-frame');
  const unverified = [];
  if (unreadable) unverified.push({ dimension: 'blank-frame', reason: 'The film canvas could not be read back, so blankness was not measured.' });
  if (manifest.audio.kind === 'silence') verified.push('audio');
  else unverified.push({ dimension: 'audio', reason: 'Temporal audio and sound sync are not measured by this stage.' });
  if (review) verified.push('semantic-visual');
  else unverified.push({ dimension: 'semantic-visual', reason: 'No visual reviewer pass ran; style fit and composition quality are not judged.' });
  return { findings, verified, unverified };
}

/**
 * Whether the evidence may pass. Stale evidence (captured against a different
 * source), missing evidence and any error finding never pass; unverified
 * dimensions are listed, never counted as verified.
 */
export function evaluateVerdict({ evidence, sourceHash, findings, unverified }) {
  if (!evidence || !evidence.sourceHash) return { status: 'unverified', reason: 'No evidence was captured.', unverified };
  if (evidence.sourceHash !== sourceHash) return { status: 'stale', reason: 'The evidence was captured against a different source revision.', unverified };
  if (findings.some(finding => finding.severity === 'error')) return { status: 'fail', reason: 'Measured errors remain.', unverified };
  return { status: 'pass', reason: null, unverified };
}
