// Shared emitter for LoRA training progress — mirrors videoGen/events.js.
// mediaJobQueue's dispatcher subscribes to 'progress'/'status'/'completed'/
// 'failed' (+ 'activity' for the idle watchdog) filtered by generationId.
import { EventEmitter } from 'events';

export const trainingEvents = new EventEmitter();
