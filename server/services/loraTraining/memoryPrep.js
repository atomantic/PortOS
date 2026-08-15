/** Training-specific memory policy built on the shared local-memory preflight. */

import { prepareLocalMemory } from '../../lib/localMemory.js';

export { unloadResidentModels, getAvailableMemoryGb, isLocalBackendUrl } from '../../lib/localMemory.js';

// Below this floor even a small 4-bit training run risks swap-thrash. Larger
// run sizing remains training-specific and still consumes `budgetGb` below.
export const TRAINING_MIN_HEADROOM_GB = 24;

export const prepareMemoryForTraining = prepareLocalMemory;
