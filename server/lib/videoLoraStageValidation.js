import { z } from 'zod';

export const a2vLoraStageStrengthsSchema = z.tuple([
  z.number().finite().min(0).max(1), z.number().finite().min(0).max(1),
]);

export const isDefaultA2vLoraStages = (value) => value == null
  || (Array.isArray(value) && value.length === 2 && value.every((v) => v === 1));
