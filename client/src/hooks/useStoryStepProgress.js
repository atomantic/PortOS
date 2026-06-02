import { storyStepProgressSseUrl } from '../services/api';
import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to the generate/refine SSE stream for one Story Builder step. Frame
 * shapes are documented in server/services/storyBuilderRunner.js. Enable only
 * after the kickoff POST resolves (so the run is registered server-side before
 * the EventSource connects) — see StoryBuilder.jsx's step runner.
 */
export function useStoryStepProgress(sessionId, stepId, { enabled = true } = {}) {
  const url = sessionId && stepId ? storyStepProgressSseUrl(sessionId, stepId) : null;
  return useSseProgress(url, { enabled });
}
