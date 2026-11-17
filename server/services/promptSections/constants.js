/**
 * Prompt-section constants shared by the full and light orchestrators.
 */

import { PROVIDER_TYPES } from '../../lib/aiToolkit/constants.js';

export const LIGHT_CONTEXT_PROVIDER_TYPES = new Set([PROVIDER_TYPES.TUI, PROVIDER_TYPES.CLI]);

export const SIMPLIFY_INLINE_REVIEW = 'review your changed code for reuse, quality, and efficiency (DRY, dead code, naming, simpler equivalents, missed edge cases)';

export const INLINE_REVIEW_LOOP_STEP = 4;

// gh api defaults to github.com, even when the checked-out repository lives on
// GitHub Enterprise. Resolve the origin host before identity probes so an
// enterprise login cannot be mistaken for an unrelated github.com account.
export const GITHUB_HOST_SETUP = `GH_HOST="$(git remote get-url origin 2>/dev/null | sed -E -e 's#^[^:]+://([^@/]+@)?([^/:]+)(:[0-9]+)?/.*#\\2#' -e 's#^([^@]+@)?([^:]+):.*#\\2#')"
if [ "$GH_HOST" = "ssh.github.com" ]; then GH_HOST="github.com"; fi`;
