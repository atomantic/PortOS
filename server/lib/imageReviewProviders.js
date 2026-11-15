/**
 * `canReviewImages(provider)`: whether a provider can run a Music Video frame check, i.e. see an image
 * one-shot with no host-writing tool (#15576).
 *
 * That covers a tool-free vision API, Codex on its subscription (`-i` under its read-only sandbox),
 * and Claude Code or Grok Build, which open the staged image with their one read tool
 * (`imageReadOneShotArgs` in `providerVendors.js`). The providers route reports it as `imageReview`,
 * and the Frame check picker filters on it.
 *
 * Which providers can review an image one-shot without host-writing tools
 * (Music Video frame checks, #15576). Pure over the provider record, so the
 * providers route can report it and the Frame check picker can filter on it.
 */
import { canReadImagesOneShot, isAuthoringOneShotProvider, isToolFreeOneShotProvider } from './providerVendors.js';
import { isCodexProvider } from './providerModels.js';
import { isCodexSubscriptionProvider } from './codexAccount.js';
import { isVisionCapableCliProvider } from './localModelHeuristics.js';

// Codex on its subscription attaches the image with `codex exec -i` and runs the
// one-shot in a read-only sandbox, so image text cannot reach a host-writing tool.
export const isCodexVisionReviewer = (provider) => provider?.type === 'cli' && isCodexSubscriptionProvider(provider) && isAuthoringOneShotProvider(provider);
// Claude Code and Grok Build open the staged image with their one read tool and nothing else (#15576).
const isReadToolVisionReviewer = (provider) => provider?.type === 'cli' && !isCodexProvider(provider)
  && isVisionCapableCliProvider(provider) && isAuthoringOneShotProvider(provider) && canReadImagesOneShot(provider);
export const canReviewImages = (provider) => (provider?.type === 'api' && isToolFreeOneShotProvider(provider))
  || isCodexVisionReviewer(provider) || isReadToolVisionReviewer(provider);
