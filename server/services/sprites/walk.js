/** Expose the sprite walk workflow through a stable service entry point. */

export { resolveChromaKey } from './animationWorkflow.js';
export { importedWalkDirections, isImportedWalkSet, walkSetRelPath, withWalkWriteTail } from './walkRecords.js';
export { getWalkState, setWalkTarget } from './walkState.js';
export { attachTuiWalkResult, startWalkGeneration } from './walkGeneration.js';
export { getWalkSourceFrames, rerunWalkPostprocess } from './walkPackaging.js';
export {
  approveWalkDirection, invalidateWalkDirectionForAnchorRevision, reopenWalkDirection,
  unlockDirectionalAnchor, unlockMainReference, unlockTurnaroundReference, unlockWalkSet,
} from './walkLocks.js';
