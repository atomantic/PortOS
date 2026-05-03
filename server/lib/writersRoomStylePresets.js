// Curated style presets shared by the Writers Room storyboard and the
// standalone Image / Video gen pages. Each Work records the *resolved* prompt
// text, not just the id — editing a preset here can't retroactively change
// historical works.
//
// Fast image models (FLUX.2 Klein, Schnell) bake garbled text into images
// whenever a prompt mentions "comic", "panel", "poster", etc. — any preset
// that nudges in that direction has to suppress every form of text via the
// negative prompt explicitly.

const TEXT_NEG = 'text, words, letters, lettering, typography, title, logo, watermark, signature, caption, word balloon, speech bubble, sound effect';

export const STYLE_PRESETS = [
  // ─── Cinema / Photo ────────────────────────────────────────────────
  {
    id: 'cinematic',
    label: 'Cinematic',
    category: 'Cinema & Photo',
    description: 'Film-still aesthetic. Anamorphic lenses, color grading, 35mm.',
    prompt: 'cinematic still, anamorphic lens, shallow depth of field, dramatic lighting, film grain, color graded, 35mm photography, atmospheric',
    negativePrompt: 'cartoon, anime, illustration, painting, low quality, blurry',
  },
  {
    id: 'noir',
    label: 'Film noir',
    category: 'Cinema & Photo',
    description: 'High-contrast black and white, 1940s detective drama.',
    prompt: 'black and white film noir, high contrast chiaroscuro, deep shadows, venetian blind lighting, 1940s detective aesthetic, smoky atmosphere, cinematic composition',
    negativePrompt: 'color photo, modern, cartoon, anime, low contrast',
  },
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    category: 'Cinema & Photo',
    description: 'Photographic realism, natural lighting, hyperdetailed.',
    prompt: 'photorealistic, hyperdetailed, natural lighting, professional photography, sharp focus, 8k, high dynamic range',
    negativePrompt: 'cartoon, anime, illustration, painting, sketch, 3d render',
  },
  {
    id: 'vintage-film',
    label: 'Vintage film',
    category: 'Cinema & Photo',
    description: '1970s Kodachrome, slight grain, warm fade.',
    prompt: '1970s kodachrome photograph, warm faded color palette, soft grain, slight light leaks, vintage film stock, nostalgic atmosphere, mid-century',
    negativePrompt: 'modern digital, sharp HDR, cartoon, 3d render, neon',
  },
  {
    id: 'polaroid',
    label: 'Polaroid snapshot',
    category: 'Cinema & Photo',
    description: 'Square instant photo, soft flash, candid moment.',
    prompt: 'polaroid instant photograph, square format, soft on-camera flash, slight motion blur, candid snapshot, faded edges, 1980s home photography',
    negativePrompt: 'sharp HDR, cinematic, painting, anime, 3d render',
  },
  {
    id: 'golden-hour',
    label: 'Golden hour',
    category: 'Cinema & Photo',
    description: 'Warm low sun, long shadows, lens flare.',
    prompt: 'golden hour photography, warm low-angle sunlight, long shadows, soft lens flare, glowing rim light, dust motes in the air, magic-hour palette',
    negativePrompt: 'overcast, harsh midday, cartoon, anime, 3d render',
  },
  {
    id: 'low-key',
    label: 'Low-key dramatic',
    category: 'Cinema & Photo',
    description: 'Heavy shadow, single light source, theatrical.',
    prompt: 'low-key lighting, single dramatic key light, deep black shadows, theatrical chiaroscuro, rembrandt-style portrait lighting, brooding atmosphere',
    negativePrompt: 'flat lighting, daylight, cartoon, low contrast',
  },

  // ─── Genre / Era ───────────────────────────────────────────────────
  {
    id: 'cyberpunk-neon',
    label: 'Cyberpunk neon',
    category: 'Genre & Era',
    description: 'Neon-soaked future cities, holograms, wet streets.',
    prompt: 'neon-soaked cyberpunk cityscape, wet rain-slick streets, holographic signage, RGB rim lighting, blade runner aesthetic, dense atmosphere, hyperdetailed',
    negativePrompt: 'natural daylight, rural, vintage, bright sky, cartoon',
  },
  {
    id: 'steampunk',
    label: 'Steampunk',
    category: 'Genre & Era',
    description: 'Brass gears, leather and copper, Victorian machinery.',
    prompt: 'steampunk aesthetic, polished brass gears and pipes, leather and copper accents, victorian machinery, gas-lamp lighting, ornate engraving, sepia palette',
    negativePrompt: 'modern, cyberpunk neon, plastic, minimalist, digital UI',
  },
  {
    id: 'dieselpunk',
    label: 'Dieselpunk',
    category: 'Genre & Era',
    description: '1940s industrial future, riveted steel, art-deco machines.',
    prompt: 'dieselpunk aesthetic, 1940s industrial-future machinery, riveted steel plating, art deco engineering, soot-stained pistons, oily metallic palette, dramatic shaft lighting',
    negativePrompt: 'sleek modern, neon, cute, pastel, cartoon',
  },
  {
    id: 'solarpunk',
    label: 'Solarpunk',
    category: 'Genre & Era',
    description: 'Lush green futurism, solar tech woven into nature.',
    prompt: 'solarpunk aesthetic, lush vertical gardens woven into curving architecture, solar panels and wind turbines integrated as design elements, soft warm sunlight, hopeful optimistic atmosphere, art-nouveau curves',
    negativePrompt: 'dystopian, dark, gritty, cyberpunk neon, ruined',
  },
  {
    id: 'dark-fantasy',
    label: 'Dark fantasy',
    category: 'Genre & Era',
    description: 'Grimdark medieval, candlelit gloom, oil-painting depth.',
    prompt: 'dark fantasy oil painting, grimdark medieval atmosphere, candlelit gloom, weathered armor and cloth, foreboding gothic architecture, frank frazetta and zdzislaw beksinski influence, painterly brushwork',
    negativePrompt: 'bright cheerful, cartoon, anime, modern, cute',
  },
  {
    id: 'high-fantasy',
    label: 'High fantasy',
    category: 'Genre & Era',
    description: 'Tolkien-esque epic, golden light, painterly grandeur.',
    prompt: 'high fantasy concept art, epic sweeping landscape, tolkien-inspired atmosphere, golden warm light, intricate elven or dwarven craft, painterly grandeur, alan lee and john howe influence',
    negativePrompt: 'photoreal, modern, cyberpunk, cartoon, low effort',
  },
  {
    id: 'space-opera',
    label: 'Space opera',
    category: 'Genre & Era',
    description: 'Star-Wars-scale sci-fi, ringed worlds, lived-in tech.',
    prompt: 'space opera concept art, vast ringed planet on the horizon, lived-in retrofuture starship interiors, dramatic sci-fi lighting, ralph mcquarrie influence, painterly cinematic',
    negativePrompt: 'modern earth, cartoon, anime, low detail, flat',
  },
  {
    id: 'cosmic-horror',
    label: 'Cosmic horror',
    category: 'Genre & Era',
    description: 'Lovecraftian dread, sickly palette, impossible geometry.',
    prompt: 'cosmic horror illustration, lovecraftian atmosphere, sickly green and bruised purple palette, non-euclidean impossible geometry, oppressive scale, ink and watercolor wash',
    negativePrompt: 'cute, bright, cheerful, cartoon, anime, modern',
  },
  {
    id: 'vaporwave',
    label: 'Vaporwave',
    category: 'Genre & Era',
    description: '80s/90s nostalgia, pink/teal grids, glitch.',
    prompt: 'vaporwave aesthetic, 1980s sunset gradient, pink and teal color palette, neon grid floor, retro CGI marble busts, VHS scanlines and glitch artifacts, nostalgic',
    negativePrompt: 'photoreal, modern, gritty, dark, oil painting',
  },
  {
    id: '80s-scifi',
    label: '80s sci-fi paperback',
    category: 'Genre & Era',
    description: 'Airbrushed paperback cover, chrome and starfields.',
    prompt: '1980s science fiction paperback cover painting, airbrushed chrome and matte starfields, bold gradients, michael whelan and chris foss influence, clean composition',
    negativePrompt: 'photoreal, modern, gritty, lo-fi, cartoon',
  },
  {
    id: 'victorian',
    label: 'Victorian',
    category: 'Genre & Era',
    description: '19th-century engraving, gas lamps, ornate detail.',
    prompt: 'victorian era illustration, 19th century steel-engraving aesthetic, gas-lamp lighting, ornate ironwork and damask, sepia and bottle-green palette, period-accurate clothing',
    negativePrompt: 'modern, futuristic, cartoon, anime, neon',
  },
  {
    id: 'wes-anderson',
    label: 'Wes Anderson',
    category: 'Genre & Era',
    description: 'Pastel symmetry, dollhouse staging, deadpan whimsy.',
    prompt: 'wes anderson cinematography, perfectly centered symmetric composition, pastel color palette, dollhouse-flat staging, retro vintage props, soft daylight, deadpan whimsical atmosphere',
    negativePrompt: 'gritty, asymmetric, dark, photoreal HDR, cartoon',
  },

  // ─── Animation ─────────────────────────────────────────────────────
  {
    id: 'ghibli',
    label: 'Studio Ghibli',
    category: 'Animation',
    description: 'Hand-painted watercolor backgrounds, expressive characters.',
    prompt: 'studio ghibli animation, hand-painted watercolor backgrounds, soft pastel palette, expressive characters, miyazaki style, whimsical, gentle lighting',
    negativePrompt: 'photorealistic, photograph, 3d render, realistic, harsh shadows, gritty',
  },
  {
    id: 'pixar',
    label: 'Pixar 3D',
    category: 'Animation',
    description: 'Vibrant 3D animated movie style with soft lighting.',
    prompt: 'pixar 3d animation style, expressive cartoon characters, vibrant saturated colors, soft volumetric lighting, polished render, cinematic depth of field',
    negativePrompt: 'photorealistic, photograph, anime, hand-drawn, sketch',
  },
  {
    id: 'disney-2d',
    label: 'Disney 2D classic',
    category: 'Animation',
    description: 'Hand-drawn cel animation, sweeping linework.',
    prompt: 'classic disney 2d animation, hand-drawn cel animation, sweeping confident linework, lush painted backgrounds, expressive character acting, golden-age technicolor palette',
    negativePrompt: 'photoreal, 3d render, gritty, anime, low effort',
  },
  {
    id: 'anime-modern',
    label: 'Anime (modern)',
    category: 'Animation',
    description: 'Crisp digital anime, vibrant cel shading, expressive.',
    prompt: 'modern anime illustration, crisp clean linework, vibrant cel shading, expressive eyes, dynamic composition, kyoto animation / makoto shinkai influence, detailed backgrounds',
    negativePrompt: 'photoreal, western cartoon, oil painting, 3d render, blurry',
  },
  {
    id: 'anime-90s',
    label: '90s anime',
    category: 'Animation',
    description: 'VHS-era cel animation, muted palette, grainy.',
    prompt: '1990s anime cel animation, hand-painted backgrounds, muted earthy palette, slight VHS grain, hard shading, akira / ghost in the shell aesthetic, cinematic framing',
    negativePrompt: 'modern digital, sharp HDR, photoreal, 3d render',
  },
  {
    id: 'claymation',
    label: 'Claymation',
    category: 'Animation',
    description: 'Stop-motion clay, fingerprint texture, soft studio light.',
    prompt: 'claymation stop-motion, hand-sculpted clay characters with visible fingerprint texture, miniature handcrafted set, soft studio lighting, aardman / laika aesthetic, tactile materiality',
    negativePrompt: 'photoreal humans, 3d render polish, cartoon flat, anime',
  },

  // ─── Illustration / Comics ─────────────────────────────────────────
  {
    id: 'graphic-novel',
    label: 'Graphic novel',
    category: 'Illustration & Comics',
    description: 'Bold ink linework, halftone shading, limited palette.',
    // "sequential art panels" reliably summons word balloons and sound
    // effects, so it's pulled out of the prompt and the negative prompt
    // explicitly suppresses every form of text the model might add.
    prompt: 'graphic novel illustration, bold ink outlines, halftone shading, limited muted color palette, mike mignola influence, cinematic framing, single full-bleed image, no text',
    negativePrompt: `photorealistic, photograph, 3d render, soft watercolor, anime, ${TEXT_NEG}, comic book cover`,
  },
  {
    id: 'comic-book',
    label: 'Comic book',
    category: 'Illustration & Comics',
    description: 'American comic book art, ink and color, dynamic angles.',
    // Same text-suppression as graphic novel — fast models bake garbled
    // word balloons and "POW" sound effects into the image otherwise.
    prompt: 'american comic book art, dynamic poses, bold ink and flat color, ben-day dots, dramatic angles, action-oriented composition, jim lee influence, single full-bleed image, no text',
    negativePrompt: `photorealistic, photograph, soft watercolor, anime, low contrast, ${TEXT_NEG}, onomatopoeia, comic book cover`,
  },
  {
    id: 'manga-bw',
    label: 'Manga (B&W)',
    category: 'Illustration & Comics',
    description: 'Black-and-white manga, screentone, dynamic linework.',
    prompt: 'black and white manga illustration, fine ink linework, screentone shading, dramatic speed lines, dynamic composition, single full-bleed image, no text',
    negativePrompt: `color, photoreal, 3d render, oil painting, ${TEXT_NEG}`,
  },
  {
    id: 'watercolor-storybook',
    label: 'Watercolor storybook',
    category: 'Illustration & Comics',
    description: "Children's-book illustration, soft edges, warm palette.",
    prompt: "watercolor children's storybook illustration, soft watercolor edges, warm pastel palette, hand-drawn ink lines, cozy and whimsical, gentle composition",
    negativePrompt: 'photorealistic, photograph, dark, gritty, cyberpunk, harsh',
  },
  {
    id: 'oil-painting',
    label: 'Oil painting',
    category: 'Illustration & Comics',
    description: 'Classical oil on canvas, visible brushwork, rich glaze.',
    prompt: 'classical oil painting, visible impasto brushwork, rich pigment glazes, chiaroscuro lighting, museum-quality canvas texture, painterly atmosphere',
    negativePrompt: 'photoreal, digital art, 3d render, cartoon, sharp HDR',
  },
  {
    id: 'impressionist',
    label: 'Impressionist',
    category: 'Illustration & Comics',
    description: 'Loose brush, dappled light, Monet/Renoir era.',
    prompt: 'impressionist oil painting, loose visible brushstrokes, dappled natural light, broken color, monet and renoir era atmosphere, dreamy outdoor scene',
    negativePrompt: 'sharp lines, photoreal, 3d render, cartoon, hard edges',
  },
  {
    id: 'art-deco',
    label: 'Art Deco',
    category: 'Illustration & Comics',
    description: '1920s geometric glamour, gold and lacquer, fan motifs.',
    prompt: 'art deco illustration, 1920s geometric glamour, gold and black lacquer palette, sunburst and fan motifs, stylized streamlined figures, erté influence, ornamental symmetry',
    negativePrompt: 'photoreal, gritty, modern, anime, low effort',
  },
  {
    id: 'art-nouveau',
    label: 'Art Nouveau',
    category: 'Illustration & Comics',
    description: 'Mucha-style flowing florals, decorative borders.',
    prompt: 'art nouveau illustration, alphonse mucha style, flowing organic floral borders, decorative arch framing, soft pastel palette with gold accents, idealized figure, ornamental linework',
    negativePrompt: 'photoreal, modern, gritty, 3d render, dark',
  },
  {
    id: 'ukiyo-e',
    label: 'Ukiyo-e woodblock',
    category: 'Illustration & Comics',
    description: 'Edo-era Japanese woodblock, flat color, clean outlines.',
    prompt: 'ukiyo-e japanese woodblock print, edo period aesthetic, flat blocks of muted color, clean black outlines, stylized waves and mountains, hokusai and hiroshige influence',
    negativePrompt: 'photoreal, 3d render, oil painting, modern, gritty',
  },
  {
    id: 'concept-art',
    label: 'Concept art',
    category: 'Illustration & Comics',
    description: 'Production-quality concept painting, painterly + crisp.',
    prompt: 'professional concept art painting, cinematic composition, painterly rendering with crisp focal detail, atmospheric perspective, production-quality, craig mullins / feng zhu influence',
    negativePrompt: 'cartoon, low effort, sketch, anime, photoreal',
  },
  {
    id: 'pixel-art',
    label: 'Pixel art',
    category: 'Illustration & Comics',
    description: '16-bit-era sprites, limited palette, crisp pixels.',
    prompt: '16-bit pixel art, limited retro game palette, crisp aliased pixels, hand-placed dithering, side-scroller sprite aesthetic, snes / sega genesis era',
    negativePrompt: 'smooth, blurry, photoreal, 3d render, anti-aliased',
  },
  {
    id: 'low-poly',
    label: 'Low-poly 3D',
    category: 'Illustration & Comics',
    description: 'Faceted geometry, flat shading, minimal palette.',
    prompt: 'low-poly 3d render, faceted geometry, flat-shaded triangular surfaces, minimal pastel palette, isometric composition, indie game aesthetic',
    negativePrompt: 'photoreal, smooth subdivision, painterly, anime, gritty',
  },
  {
    id: 'isometric',
    label: 'Isometric',
    category: 'Illustration & Comics',
    description: 'Tilted top-down, miniature diorama, clean shapes.',
    prompt: 'isometric illustration, 30-degree tilted top-down perspective, clean geometric shapes, miniature diorama composition, soft pastel palette, modern editorial illustration',
    negativePrompt: 'photoreal, dramatic perspective, gritty, anime',
  },
  {
    id: 'blueprint',
    label: 'Technical blueprint',
    category: 'Illustration & Comics',
    description: 'White-on-blue line drawing, callouts, schematic.',
    prompt: 'technical blueprint illustration, crisp white linework on deep blue background, schematic cross-section, dimension callouts, drafting aesthetic, no text',
    negativePrompt: `photoreal, painterly, anime, 3d render, ${TEXT_NEG}`,
  },
  {
    id: 'ink-wash',
    label: 'Ink wash (sumi-e)',
    category: 'Illustration & Comics',
    description: 'Brush-and-ink, negative space, gestural strokes.',
    prompt: 'sumi-e ink wash painting, gestural brush strokes on rice paper, dramatic negative space, monochromatic black ink with single accent color, zen minimalism',
    negativePrompt: 'photoreal, color saturation, 3d render, cartoon, busy',
  },
];

export const STYLE_PRESET_IDS = STYLE_PRESETS.map((p) => p.id);

// 'custom' = user wrote their own prompt without picking a preset.
// 'none' = no style applied (image-gen uses scene visualPrompt verbatim).
export const STYLE_ID = { NONE: 'none', CUSTOM: 'custom' };
export const ALL_STYLE_IDS = [STYLE_ID.NONE, STYLE_ID.CUSTOM, ...STYLE_PRESET_IDS];

export const EMPTY_IMAGE_STYLE = { presetId: STYLE_ID.NONE, prompt: '', negativePrompt: '' };

export function findStylePreset(id) {
  return STYLE_PRESETS.find((p) => p.id === id) || null;
}
