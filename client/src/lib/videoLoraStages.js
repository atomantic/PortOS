export const isDefaultA2vLoraStages = (value) => value == null
  || (Array.isArray(value) && value.length === 2 && value.every((v) => v === 1));
