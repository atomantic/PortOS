import { describe, it, expect } from 'vitest';
import { PRODUCTION_TRANSIENT_RETRIES, transientProductionRetry } from './production.js';

const BUSY = "Gemini did not render this clip: I'm at full capacity. Please try again later. (still busy after 4 retries over 15 min; tap Retry to try again)";
const clipFailure = (key, error) => ({ key, kind: 'clip', sceneId: 's1', status: 'failed', error });

describe('transientProductionRetry', () => {
  it('lets an orchestrated run retry a clip whose provider stayed busy', () => {
    const run = { steps: [clipFailure('a', BUSY)] };
    expect(transientProductionRetry(run)).toEqual(run.steps);
  });

  it('parks the run once the busy slot spent its retries', () => {
    const steps = Array.from({ length: PRODUCTION_TRANSIENT_RETRIES + 1 }, (_, i) => clipFailure(`k${i}`, BUSY));
    expect(transientProductionRetry({ steps })).toBeNull();
  });

  it('parks on a usage limit, which waiting does not clear', () => {
    expect(transientProductionRetry({ steps: [clipFailure('a', 'Gemini did not render this clip: you reached your limit')] })).toBeNull();
  });
});
