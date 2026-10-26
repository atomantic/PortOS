/** Frozen shipped text, version 2. No named canon or install-specific state. */
import { REALITY_STARTER_V1 } from './realityStarterV1.js';

export const REALITY_STARTER_V2 = Object.freeze({
  ...REALITY_STARTER_V1,
  styleNotes: REALITY_STARTER_V1.styleNotes + ' Use a consistent natural analog photographic response: motivated directional light, grounded shadows and smooth highlight transitions. Strong style comes from light, tone and material texture; keep film artifacts restrained.',
  influences: Object.freeze({
    embrace: Object.freeze([...REALITY_STARTER_V1.influences.embrace, 'directional available light with natural falloff', 'retained shadow depth and restrained skin highlights']),
    avoid: Object.freeze([...REALITY_STARTER_V1.influences.avoid, 'pervasive fill light', 'glossy advertising treatment']),
  }),
  visualProfile: {
    "version": 1,
    "generation": {
      "enabled": true,
      "lighting": "Motivated available light from windows, sky and practical fixtures; directional falloff, unfilled shadow depth and restrained specular highlights. Preserve believable exposure and mixed color temperatures when motivated.",
      "optics": "Observed 35mm photography with natural perspective and readable optical detail. Very subtle lens diffusion; no deliberate missed focus. Generate a clean ungraded image without baked grain, scratches or light leaks.",
      "materials": "Natural skin texture, fine hair, asymmetry and age-specific detail; lived-in clothing and physically plausible materials. Candid human behavior and understated photographic color.",
      "avoid": "studio beauty lighting, pervasive fill light, unmotivated rim lights, glossy advertising treatment, beauty retouching, waxy skin, synthetic HDR clarity, excessive sharpening"
    },
    "finishing": {
      "mode": "preview",
      "look": {
        "version": 2,
        "preset": "natural-35mm",
        "defocus": 0,
        "diffusion": 0,
        "halation": 0.1,
        "halationColor": "#ff5a1f",
        "chroma": 0,
        "bleed": 0,
        "exposure": 0,
        "contrast": 0,
        "fade": 0,
        "saturation": -0.04,
        "warmth": 0.03,
        "tint": 0,
        "shoulder": 0.5,
        "toe": 0.2,
        "highlightChroma": 0.35,
        "cast": 0,
        "castColor": "#b9c04a",
        "splitTone": 0,
        "shadowColor": "#1f4a46",
        "highlightColor": "#ffb067",
        "grain": 0.18,
        "grainSize": 0.15,
        "grainColor": false,
        "tapeNoise": 0,
        "vignette": 0.06,
        "leak": 0,
        "leakColor": "#ff7a2a",
        "weave": 0,
        "flicker": 0
      },
      "colorAmount": 1,
      "textureAmount": 1
    }
  },
});
