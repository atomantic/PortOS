import { EventEmitter } from 'node:events';

// Emitted only after a sprite manifest, run or attached candidate is saved.
// Payloads are invalidations, never prompts, assets or private record content.
export const spriteEvents = new EventEmitter();
export const emitSpriteChanged = (recordId) => spriteEvents.emit('changed', { recordId });
