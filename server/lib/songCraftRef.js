/** Song vocabulary injected into the generate/evaluate/derive prompts.
 * The browser enriches the same pure data with guide-only presentation fields.
 */
import { RHYTHM_SHAPES, VOICE_LAYERS, HARMONY_PARTS } from './songCraftParts.js';

export { RHYTHM_SHAPES, VOICE_LAYERS, HARMONY_PARTS };

// The dirge-family shapes (the lament the workbench centers on), in order.
export const DIRGE_RHYTHM_SHAPES = RHYTHM_SHAPES.filter((s) => s.dirge);

// The parts the derive tool generates, in declaration order low→high.
export const DERIVABLE_HARMONY_PARTS = HARMONY_PARTS.filter((p) => p.derivable);
