// Style presets for the per-Work "world style" image-gen prompt prefix.
// These ship as code (not gitignored data) so every install gets the same
// curated starting set. Each work stores the *resolved* prompt text on its
// manifest, not the preset id alone — so editing a preset here doesn't
// silently change historical works.

export const STYLE_PRESETS = [
  {
    id: 'cinematic',
    label: 'Cinematic',
    description: 'Film-still aesthetic. Anamorphic lenses, color grading, 35mm.',
    prompt: 'cinematic still, anamorphic lens, shallow depth of field, dramatic lighting, film grain, color graded, 35mm photography, atmospheric',
    negativePrompt: 'cartoon, anime, illustration, painting, low quality, blurry',
  },
  {
    id: 'noir',
    label: 'Film noir',
    description: 'High-contrast black and white, 1940s detective drama.',
    prompt: 'black and white film noir, high contrast chiaroscuro, deep shadows, venetian blind lighting, 1940s detective aesthetic, smoky atmosphere, cinematic composition',
    negativePrompt: 'color photo, modern, cartoon, anime, low contrast',
  },
  {
    id: 'cyberpunk-neon',
    label: 'Cyberpunk neon',
    description: 'Neon-soaked future cities, holograms, wet streets.',
    prompt: 'neon-soaked cyberpunk cityscape, wet rain-slick streets, holographic signage, RGB rim lighting, blade runner aesthetic, dense atmosphere, hyperdetailed',
    negativePrompt: 'natural daylight, rural, vintage, bright sky, cartoon',
  },
  {
    id: 'ghibli',
    label: 'Studio Ghibli',
    description: 'Hand-painted watercolor backgrounds, expressive characters.',
    prompt: 'studio ghibli animation, hand-painted watercolor backgrounds, soft pastel palette, expressive characters, miyazaki style, whimsical, gentle lighting',
    negativePrompt: 'photorealistic, photograph, 3d render, realistic, harsh shadows, gritty',
  },
  {
    id: 'pixar',
    label: 'Pixar 3D',
    description: 'Vibrant 3D animated movie style with soft lighting.',
    prompt: 'pixar 3d animation style, expressive cartoon characters, vibrant saturated colors, soft volumetric lighting, polished render, cinematic depth of field',
    negativePrompt: 'photorealistic, photograph, anime, hand-drawn, sketch',
  },
  {
    id: 'graphic-novel',
    label: 'Graphic novel',
    description: 'Bold ink linework, halftone shading, limited palette.',
    prompt: 'graphic novel illustration, bold ink outlines, halftone shading, limited muted color palette, sequential art panels, mike mignola influence, cinematic framing',
    negativePrompt: 'photorealistic, photograph, 3d render, soft watercolor, anime',
  },
  {
    id: 'watercolor-storybook',
    label: 'Watercolor storybook',
    description: "Children's-book illustration, soft edges, warm palette.",
    prompt: "watercolor children's storybook illustration, soft watercolor edges, warm pastel palette, hand-drawn ink lines, cozy and whimsical, gentle composition",
    negativePrompt: 'photorealistic, photograph, dark, gritty, cyberpunk, harsh',
  },
  {
    id: 'comic-book',
    label: 'Comic book',
    description: 'American comic book art, ink and color, dynamic angles.',
    prompt: 'american comic book art, dynamic poses, bold ink and flat color, ben-day dots, dramatic angles, action-oriented composition, jim lee influence',
    negativePrompt: 'photorealistic, photograph, soft watercolor, anime, low contrast',
  },
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    description: 'Photographic realism, natural lighting, hyperdetailed.',
    prompt: 'photorealistic, hyperdetailed, natural lighting, professional photography, sharp focus, 8k, high dynamic range',
    negativePrompt: 'cartoon, anime, illustration, painting, sketch, 3d render',
  },
];

export const STYLE_PRESET_IDS = STYLE_PRESETS.map((p) => p.id);

// 'custom' = user wrote their own prompt without picking a preset.
// 'none' = no style applied (image-gen uses scene visualPrompt verbatim).
export const SPECIAL_STYLE_IDS = ['none', 'custom'];

export function findStylePreset(id) {
  return STYLE_PRESETS.find((p) => p.id === id) || null;
}
