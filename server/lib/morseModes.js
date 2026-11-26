/** POST Morse practice mode IDs and their corresponding drill types. */

export const MORSE_MODE_IDS = Object.freeze(['copy', 'head-copy', 'send']);
export const MORSE_DRILL_TYPES = MORSE_MODE_IDS.map((id) => `morse-${id}`);
