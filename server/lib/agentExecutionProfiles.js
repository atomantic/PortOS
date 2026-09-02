/**
 * Named execution postures shared by the agent spawners and their environment
 * builders. Keep this leaf free of provider/runtime imports so adding a
 * restricted profile cannot pull the full provider graph into schedule reads.
 */

export const PUBLIC_REVIEW_EXECUTION_PROFILE = 'public-review';
