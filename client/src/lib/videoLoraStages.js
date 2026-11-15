/**
 * Recognize the legacy A2V user-LoRA stage multipliers without clearing an explicit schedule on
 * backend changes.
 */

export const isDefaultA2vLoraStages = (value) => value == null
  || (Array.isArray(value) && value.length === 2 && value.every((v) => v === 1));
