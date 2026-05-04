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
    prompt: 'cinematic film still captured on Kodak Vision3 500T motion picture stock, 35mm anamorphic lens with characteristic horizontal lens flares and oval bokeh, shallow depth of field with creamy out-of-focus backgrounds, motivated key lighting from a single dramatic source paired with subtle bounce fill, professional teal-and-orange color grading with crushed blacks and rolled-off highlights, fine organic film grain, 2.39:1 widescreen composition with rule-of-thirds framing, atmospheric haze and volumetric light shafts cutting through dust, naturalistic skin tones, evocative production design, master-shot blocking, the unmistakable visual signature of a prestige feature film by Roger Deakins or Emmanuel Lubezki',
    negativePrompt: 'cartoon, anime, illustration, painting, low quality, blurry, flat lighting, oversaturated, plastic skin, amateur snapshot',
  },
  {
    id: 'noir',
    label: 'Film noir',
    category: 'Cinema & Photo',
    description: 'High-contrast black and white, 1940s detective drama.',
    prompt: 'classic black-and-white film noir cinematography, extreme high-contrast chiaroscuro with deep crushed blacks and bright specular highlights, dramatic venetian-blind shadow patterns striping across faces and walls, single hard key light from a low angle casting elongated shadows, smoky atmosphere with cigarette haze drifting through shafts of light, rain-slick streets reflecting streetlamp pools, 1940s Los Angeles detective drama aesthetic, fedoras and trench coats and silhouetted figures in doorways, deep-focus composition with foreground objects looming large, expressionist German UFA-influenced framing, the visual language of John Alton, Gregg Toland, and Nicholas Musuraca',
    negativePrompt: 'color photo, modern, cartoon, anime, low contrast, soft pastel, daylight, cheerful, flat lighting',
  },
  {
    id: 'photorealistic',
    label: 'Photorealistic',
    category: 'Cinema & Photo',
    description: 'Photographic realism, natural lighting, hyperdetailed.',
    prompt: 'photorealistic image with hyperdetailed micro-textures rendered down to skin pores, fabric weave, and surface scratches, captured on a full-frame mirrorless camera with a fast prime lens at f/1.8, natural directional lighting with soft shadows and accurate global illumination, true-to-life color reproduction with neutral white balance, sharp tack focus on the subject with smooth bokeh falloff, professional studio or environmental portrait photography, 8K resolution with high dynamic range, accurate physical materials with correct subsurface scattering on skin, no artistic stylization, indistinguishable from a National Geographic or Magnum Photos editorial frame',
    negativePrompt: 'cartoon, anime, illustration, painting, sketch, 3d render, plastic skin, oversaturated, low resolution, artifacts, deformed anatomy',
  },
  {
    id: 'vintage-film',
    label: 'Vintage film',
    category: 'Cinema & Photo',
    description: '1970s Kodachrome, slight grain, warm fade.',
    prompt: '1970s Kodachrome 64 photograph with the unmistakable warm faded color palette of mid-century slide film, deep saturated reds and amber yellows balanced against muted earthy greens, soft organic film grain with subtle halation around bright highlights, slight light leaks bleeding warm orange into the frame edges, gentle vignetting at the corners, slightly elevated black levels giving milky shadows, vintage 50mm prime lens with mild barrel distortion, suburban Americana or European travel photography aesthetic, evocative of family slideshows and National Geographic from the Vietnam era, nostalgic mid-century atmosphere, the look of Stephen Shore or William Eggleston',
    negativePrompt: 'modern digital, sharp HDR, cartoon, 3d render, neon, ultra-clean, plastic, oversharpened, contemporary',
  },
  {
    id: 'polaroid',
    label: 'Polaroid snapshot',
    category: 'Cinema & Photo',
    description: 'Square instant photo, soft flash, candid moment.',
    prompt: 'authentic Polaroid SX-70 instant photograph in classic 1:1 square format with the iconic white border at the bottom, slightly washed-out colors with a cool cyan cast in the shadows and warm yellow in the highlights, soft on-camera flash creating a hot-spot on the subject and falloff into deep shadow at the edges, slight motion blur from a hand-held shutter at 1/60th, candid unposed snapshot framing with imperfect composition, faded chemical edges and minor exposure imperfections, fingerprints and dust specks on the print surface, late-1970s through 1980s home photography aesthetic, evocative of refrigerator magnets and shoebox memories, the lo-fi spontaneous quality of a Christmas morning or backyard barbecue captured in a single click',
    negativePrompt: 'sharp HDR, cinematic, painting, anime, 3d render, ultra-clean, modern smartphone, professional studio lighting',
  },
  {
    id: 'golden-hour',
    label: 'Golden hour',
    category: 'Cinema & Photo',
    description: 'Warm low sun, long shadows, lens flare.',
    prompt: 'golden hour photography captured in the last 45 minutes before sunset, warm low-angle sunlight raking across the scene at a 10-degree angle, long elongated shadows stretching from every object, soft anamorphic lens flare blooming across the frame, glowing rim light separating the subject from the background, dust motes and pollen suspended in the air catching the light, magic-hour color palette of saturated amber, peach, and rose-gold gradients, sky transitioning from warm orange near the horizon to soft cyan overhead, atmospheric haze and god-rays where the light cuts through trees or buildings, tack-sharp subject with creamy bokeh background, captured on a fast 85mm prime lens, the romantic painterly quality of a Terrence Malick frame',
    negativePrompt: 'overcast, harsh midday, cartoon, anime, 3d render, flat lighting, blue hour, fluorescent, indoor',
  },
  {
    id: 'low-key',
    label: 'Low-key dramatic',
    category: 'Cinema & Photo',
    description: 'Heavy shadow, single light source, theatrical.',
    prompt: 'low-key dramatic portrait lighting with a 16:1 lighting ratio, single hard key light positioned at 45 degrees above and to the side of the subject, deep impenetrable black shadows occupying 70 percent of the frame, theatrical Rembrandt-style triangular cheek light pattern, no fill light allowing the shadow side to fall completely into darkness, brooding contemplative atmosphere, fine selective rim light tracing the edge of the subject against the void, Caravaggio-inspired tenebrism with painterly chiaroscuro modeling, rich tactile texture on skin and fabric where the light falls, the visual language of a Vermeer interior or an Annie Leibovitz Vanity Fair cover, captured on a medium-format camera with a portrait lens',
    negativePrompt: 'flat lighting, daylight, cartoon, low contrast, overhead fluorescent, washed out, soft and even, ambient bright',
  },

  // ─── Genre / Era ───────────────────────────────────────────────────
  {
    id: 'cyberpunk-neon',
    label: 'Cyberpunk neon',
    category: 'Genre & Era',
    description: 'Neon-soaked future cities, holograms, wet streets.',
    prompt: 'neon-soaked cyberpunk megacity at night, perpetual rainfall pooling on cracked asphalt and reflecting holographic billboards above, towering vertical architecture with kanji and katakana signage stacked into the sky, magenta and cyan neon tubing carving through dense atmospheric haze, RGB-split rim lighting on every figure, glowing hologram advertisements with translucent dancers and product pitches looping in midair, steam venting from sewer grates and rooftop AC units, layered Blade Runner 2049 + Ghost in the Shell + Akira aesthetic, low-altitude flying vehicles trailing red taillight streaks, dense crowds in techwear and rain ponchos navigating night-market food stalls, hyperdetailed wet surfaces with chromatic aberration, anamorphic lens with horizontal flares from every light source, oppressive corporate brutalism wrapped in disposable digital glamour',
    negativePrompt: 'natural daylight, rural, vintage, bright sky, cartoon, sunny, suburban, pastoral, clean and minimalist',
  },
  {
    id: 'steampunk',
    label: 'Steampunk',
    category: 'Genre & Era',
    description: 'Brass gears, leather and copper, Victorian machinery.',
    prompt: 'steampunk Victorian-industrial aesthetic, polished brass gears and copper pipework with visible rivets and pressure gauges, oxidized verdigris patina on aging metal surfaces, leather strapping and stitched goggles with smoked-glass lenses, mahogany cabinetry and burnished walnut paneling, wrought-iron filigree and ornate engraved scrollwork, gas-lamp lighting with warm flickering amber glow casting long shadows, drifting steam vapor and coal smoke rising through pneumatic tubes, sepia and oxblood color palette accented with antique gold leaf, mid-19th-century industrial revolution alternate-history vibe, airships with brass propellers visible through arched factory windows, the visual world of Hayao Miyazaki crossed with Jules Verne crossed with Industrial Revolution Manchester',
    negativePrompt: 'modern, cyberpunk neon, plastic, minimalist, digital UI, sleek glass, sci-fi futurism, anime',
  },
  {
    id: 'dieselpunk',
    label: 'Dieselpunk',
    category: 'Genre & Era',
    description: '1940s industrial future, riveted steel, art-deco machines.',
    prompt: 'dieselpunk alternate-1940s industrial-future aesthetic, massive riveted steel plating and stamped iron paneling, Art Deco engineering motifs with chevrons and streamlined fairings, soot-stained cast-iron pistons and exposed exhaust manifolds, oily metallic palette of gunmetal grey, brass, oxblood red, and military olive drab, dramatic shaft lighting cutting through factory smoke and machine oil mist, towering smokestacks and zeppelin hangars dominating the skyline, hand-painted serif signage on industrial machinery, retrofuturist trans-Atlantic-liner glamour fused with WW2-era heavy industry, the world of Bioshock + The Iron Giant + 1939 New York World\'s Fair, deep theatrical chiaroscuro lighting, hand-cranked machinery and analog dials',
    negativePrompt: 'sleek modern, neon, cute, pastel, cartoon, anime, minimalist, digital interface',
  },
  {
    id: 'solarpunk',
    label: 'Solarpunk',
    category: 'Genre & Era',
    description: 'Lush green futurism, solar tech woven into nature.',
    prompt: 'solarpunk hopeful-future aesthetic, lush vertical hanging gardens cascading down curving organic architecture, solar panels and wind turbines elegantly integrated as decorative design elements rather than industrial fixtures, biophilic curving forms inspired by Antoni Gaudí and Hayao Miyazaki, soft warm afternoon sunlight filtering through translucent leaves, hopeful optimistic atmosphere with vibrant living color, native flowering plants and pollinators woven through every surface, rainwater catchment streams and clear pools threading between buildings, art-nouveau curves with iridescent glass and warm reclaimed wood, communal terraces with people gardening and sharing meals outdoors, soft pastel sky transitioning to warm peach at the horizon, the visual world of Studio Ghibli\'s Laputa crossed with the Eden Project crossed with a permaculture commune',
    negativePrompt: 'dystopian, dark, gritty, cyberpunk neon, ruined, post-apocalyptic, brutalist concrete, polluted',
  },
  {
    id: 'dark-fantasy',
    label: 'Dark fantasy',
    category: 'Genre & Era',
    description: 'Grimdark medieval, candlelit gloom, oil-painting depth.',
    prompt: 'dark fantasy oil painting in the grimdark medieval tradition, weathered figures in tarnished plate armor and tattered crimson cloaks, candlelit gloom with single sources of warm flame illumination falling off into pitch-black shadow, foreboding gothic cathedral architecture with vaulting ribbed arches and broken stained glass, mist clinging to ancient stone tombs and overgrown burial grounds, palette of midnight blue, oxblood red, tarnished gold, and cold steel grey, painterly visible brushwork with thick impasto highlights and translucent shadow glazes, oppressive sublime scale dwarfing human figures, the influence of Frank Frazetta\'s muscular barbarian compositions, Zdzisław Beksiński\'s nightmarish architectural dread, and Berserk-era Kentaro Miura\'s ink-saturated darkness, the visual world of Dark Souls and A Song of Ice and Fire',
    negativePrompt: 'bright cheerful, cartoon, anime, modern, cute, pastel, sunny, clean and pristine',
  },
  {
    id: 'high-fantasy',
    label: 'High fantasy',
    category: 'Genre & Era',
    description: 'Tolkien-esque epic, golden light, painterly grandeur.',
    prompt: 'high fantasy concept art painting in the grand Tolkien tradition, epic sweeping landscape with mist-veiled mountain ranges receding into atmospheric perspective, golden warm afternoon light spilling across rolling green meadows and silver-leafed forests, intricate elven mithril craftsmanship or dwarven runic stonework rendered in loving microdetail, soaring gothic spires and ancient stone bridges crossing impossibly deep ravines, painterly grandeur with rich glazed shadows and luminous highlights, palette of emerald green, antique gold, twilight purple, and warm cream, soft volumetric god-rays cutting through cloud breaks, hand-painted clouds with Maxfield Parrish luminosity, distant figures providing scale against vast natural wonders, the visual influence of Alan Lee\'s watercolors, John Howe\'s ink-and-gouache compositions, and Ted Nasmith\'s ethereal landscape paintings',
    negativePrompt: 'photoreal, modern, cyberpunk, cartoon, low effort, gritty contemporary, urban, sci-fi',
  },
  {
    id: 'space-opera',
    label: 'Space opera',
    category: 'Genre & Era',
    description: 'Star-Wars-scale sci-fi, ringed worlds, lived-in tech.',
    prompt: 'space opera concept art in the grand cinematic tradition, vast ringed gas-giant planet dominating the horizon with visible band striations and orbiting moons, lived-in retrofuture starship interiors with worn rubber matting, exposed cable runs, illuminated CRT panels, and hand-stenciled bulkhead signage, dramatic backlit sci-fi lighting with practical glowing elements built into every console, asteroid fields and spiral nebulae filling the deep-black void, dust and atmospheric haze adding scale to docking bays and hangars, palette of warm amber control panels against cold blue starlight, fighters and capital ships with weathered hull plating showing battle scars and field repairs, painterly cinematic composition, the foundational visual influence of Ralph McQuarrie, Syd Mead, and John Berkey crossed with the production design of Star Wars + Battlestar Galactica + The Expanse',
    negativePrompt: 'modern earth, cartoon, anime, low detail, flat, contemporary, mundane, suburban',
  },
  {
    id: 'cosmic-horror',
    label: 'Cosmic horror',
    category: 'Genre & Era',
    description: 'Lovecraftian dread, sickly palette, impossible geometry.',
    prompt: 'cosmic horror illustration in the Lovecraftian tradition, sickly bilious green and bruised purple palette accented with oily black and necrotic yellow, non-Euclidean impossible geometry with angles that should not meet, oppressive cyclopean scale dwarfing tiny human figures into ant-sized witnesses, alien architecture suggesting unknowable mathematics carved by entities older than time, ink-and-watercolor wash technique with bleeding edges and granular pigment pooling, churning seas under starless skies and ancient half-submerged megaliths, suggestive shapes barely glimpsed behind veils of mist that imply rather than depict the horror, the visual influence of John Coulthart, Ian Miller\'s ornamental ink work, Mike Mignola\'s shadow-based composition, and Zdzisław Beksiński\'s dreamlike dread, the existential weight of Caspar David Friedrich crossed with the suggestive horror of Goya\'s Black Paintings',
    negativePrompt: 'cute, bright, cheerful, cartoon, anime, modern, pastel, sunny, clean and friendly',
  },
  {
    id: 'vaporwave',
    label: 'Vaporwave',
    category: 'Genre & Era',
    description: '80s/90s nostalgia, pink/teal grids, glitch.',
    prompt: 'vaporwave aesthetic with full late-80s and early-90s nostalgic kitsch, electric pink and cool teal sunset gradient sky with a giant low setting sun, infinite neon grid floor receding into perspective vanishing point, retro CGI marble Greco-Roman statue busts and floating geometric primitives (chrome torus, pink cube, palm tree silhouettes), VHS scanlines and chromatic aberration with horizontal tracking distortion, glitch artifacts and datamoshing pixel smears, Japanese katakana and faded mall-typography decorative elements, palm trees and lone Doric columns standing in shallow chrome water, dolphin and Venus statue iconography, color palette dominated by hot magenta, electric cyan, lavender purple, and chrome silver, the lo-fi YouTube playlist visual world of MACINTOSH PLUS and Saint Pepsi, evocative of an abandoned 1991 shopping mall food court at midnight',
    negativePrompt: 'photoreal, modern, gritty, dark, oil painting, naturalistic, contemporary, organic, painterly',
  },
  {
    id: '80s-scifi',
    label: '80s sci-fi paperback',
    category: 'Genre & Era',
    description: 'Airbrushed paperback cover, chrome and starfields.',
    prompt: '1980s science fiction paperback cover painting executed in airbrush and acrylic, gleaming chromed spacecraft hulls catching starlight reflections, deep matte black starfields dotted with prismatic galactic nebulae, bold high-contrast color gradients of electric magenta, deep cobalt, and laser cyan, clean wedge-shaped composition with the hero ship banking in foreground silhouetted against a giant ringed planet, perfectly smooth airbrushed gradients with no visible brush texture, sense of awe-struck cosmic scale and pulp adventure, visible Ben-Day-style highlights on metal, slightly stylized human figures in bubble helmets and form-fitting flight suits, retrofuturist optimism of the Apollo-to-Voyager era, the foundational visual influence of Michael Whelan, Chris Foss, Peter Elson, and Boris Vallejo, evocative of a Robert Heinlein or Larry Niven mass-market paperback in a 1983 Waldenbooks',
    negativePrompt: 'photoreal, modern, gritty, lo-fi, cartoon, contemporary, dystopian dirty, anime',
  },
  {
    id: 'victorian',
    label: 'Victorian',
    category: 'Genre & Era',
    description: '19th-century engraving, gas lamps, ornate detail.',
    prompt: 'Victorian-era 19th-century steel-engraving illustration in the tradition of The Illustrated London News and Harper\'s Weekly, intricate cross-hatching and stipple work building tonal value with no halftone or photographic gradation, gas-lamp lighting with warm halo glow softening into deep ink shadow, ornate cast-iron filigree and damask wallpaper patterns filling backgrounds, period-accurate clothing rendered in microscopic detail (corseted gowns, frock coats, top hats, walking sticks), sepia-toned ink wash and bottle-green tinted highlights, decorative scrollwork frames and ornamental capital letters, fog-shrouded London streets with horse-drawn hansom cabs and gas lamps glowing through coal smoke, the visual world of Charles Dickens novels crossed with Sherlock Holmes Strand Magazine illustrations by Sidney Paget, evocative of an 1885 broadsheet folded out across a mahogany reading-room table',
    negativePrompt: 'modern, futuristic, cartoon, anime, neon, digital, contemporary, color photography',
  },
  {
    id: 'wes-anderson',
    label: 'Wes Anderson',
    category: 'Genre & Era',
    description: 'Pastel symmetry, dollhouse staging, deadpan whimsy.',
    prompt: 'Wes Anderson cinematography aesthetic, perfectly centered symmetric composition with the subject dead-center in the frame, immaculate dollhouse-flat planar staging where every object sits parallel to the picture plane, controlled pastel color palette of pale rose pink, mustard yellow, mint green, and warm cream, retro vintage props and meticulously curated period-appropriate set dressing rendered with obsessive accuracy, soft natural daylight with no harsh shadows, deadpan whimsical melancholy mood, characters posed with poker-faced theatrical formality looking directly into the lens, hand-painted typography and embroidered patches as part of the production design, ornate but slightly faded decorative wallpaper in the background, the visual signature of Robert Yeoman\'s cinematography in Grand Budapest Hotel, Moonrise Kingdom, and The French Dispatch, captured on a slightly wide focal length with everything in focus',
    negativePrompt: 'gritty, asymmetric, dark, photoreal HDR, cartoon, chaotic composition, action-packed, modern digital, neon',
  },

  // ─── Animation ─────────────────────────────────────────────────────
  {
    id: 'ghibli',
    label: 'Studio Ghibli',
    category: 'Animation',
    description: 'Hand-painted watercolor backgrounds, expressive characters.',
    prompt: 'Studio Ghibli hand-drawn animation aesthetic, lush hand-painted watercolor backgrounds with visible brushwork in cumulus clouds and rolling green meadows, soft pastel palette dominated by sky blue, grass green, and warm cream, expressive character animation with rounded forms, large emotive eyes, and gentle subtle movement, Hayao Miyazaki and Kazuo Oga environmental storytelling with meticulous attention to wind in tall grass, sun-dappled forest floors, and steaming bowls of food, gentle natural lighting with soft volumetric god-rays through tree canopies, painterly atmospheric perspective with mist softening distant mountains, hand-inked character lines in warm sepia rather than harsh black, whimsical melancholic atmosphere balancing wonder and loss, period European or rural Japanese setting full of character details (kettles, books, hand-tools, hanging laundry), the unmistakable visual world of Spirited Away, My Neighbor Totoro, and Princess Mononoke',
    negativePrompt: 'photorealistic, photograph, 3d render, realistic, harsh shadows, gritty, cyberpunk, dark and edgy, sharp digital lines',
  },
  {
    id: 'pixar',
    label: 'Pixar 3D',
    category: 'Animation',
    description: 'Vibrant 3D animated movie style with soft lighting.',
    prompt: 'Pixar-style 3D animated feature-film aesthetic, expressive cartoon characters with exaggerated proportions (oversized heads and eyes, simplified appealing forms), vibrant saturated color palette tuned for emotional storytelling, soft volumetric studio lighting with warm key, cool fill, and rim separation lighting on every subject, polished subsurface-scattering on skin with gentle peach-and-rose tones, cinematic depth of field with creamy bokeh on background elements, rich PBR materials (felt, plush fabric, polished wood, soft cotton) rendered with tactile microdetail, painterly stylized environments with believable physics but heightened color, three-act feature-film cinematography with thoughtful blocking and focal layering, the visual influence of Toy Story, Up, Inside Out, and Coco, RenderMan global illumination, cheerful but grounded production design',
    negativePrompt: 'photorealistic, photograph, anime, hand-drawn, sketch, gritty, dark and edgy, low-poly, flat shading',
  },
  {
    id: 'disney-2d',
    label: 'Disney 2D classic',
    category: 'Animation',
    description: 'Hand-drawn cel animation, sweeping linework.',
    prompt: 'classic Disney 2D hand-drawn cel animation in the Nine Old Men tradition, sweeping confident character linework with weighted ink that thickens on the shadow side and tapers to nothing on the light side, lush hand-painted watercolor and gouache backgrounds with multiplane camera depth, expressive squash-and-stretch character acting with full follow-through and overlapping action, golden-age Technicolor palette of saturated reds, royal blues, and warm golds, soft cel-shaded lighting with painted highlights and shadows on skin, anthropomorphic side characters with appealing rounded silhouettes, ornate Bavarian or French storybook architecture, the visual influence of Snow White, Sleeping Beauty, Pinocchio, and the Eyvind Earle and Mary Blair concept-art tradition, Frank-and-Ollie Twelve Principles of Animation rendering quality',
    negativePrompt: 'photoreal, 3d render, gritty, anime, low effort, dark and edgy, modern flat vector, cyberpunk',
  },
  {
    id: 'anime-modern',
    label: 'Anime (modern)',
    category: 'Animation',
    description: 'Crisp digital anime, vibrant cel shading, expressive.',
    prompt: 'modern Japanese anime illustration in the contemporary digital tradition, crisp clean linework with consistent stroke weight, vibrant cel-shaded coloring with two-tone shadows in cool blue-purple, expressive large luminous eyes with multiple highlight reflections and detailed iris work, dynamic dramatic composition with low or high camera angles and motion lines, intricately detailed hyperrealistic backgrounds rendered with painterly atmospheric perspective and visible brushwork in clouds and foliage, sun-flare and bloom lighting with chromatic aberration, color palette of saturated sky blue, magenta sunset, and lush emerald, the visual influence of Kyoto Animation\'s warmth, Makoto Shinkai\'s photographic environments, Ufotable\'s digital effects, and the contemporary lineage of Your Name, Demon Slayer, and Violet Evergarden, ultra-detailed school uniforms, urban Japan, or fantasy costuming',
    negativePrompt: 'photoreal, western cartoon, oil painting, 3d render, blurry, gritty live-action, low detail, sketch',
  },
  {
    id: 'anime-90s',
    label: '90s anime',
    category: 'Animation',
    description: 'VHS-era cel animation, muted palette, grainy.',
    prompt: '1990s-era Japanese anime cel animation, hand-painted gouache backgrounds with visible brush texture, muted earthy palette of warm grey, dusty olive, faded brick red, and ochre brown rather than modern saturated digital colors, hard two-tone cel shading with crisp shadow edges, slight VHS grain and chromatic aberration from analog tape transfer, slightly blurred motion lines and traditional hand-drawn smear frames, neon-lit 1990s Tokyo cyberpunk cityscapes or post-apocalyptic ruins, characters in oversized practical jackets and high-tech gear, atmospheric heavy use of fog, rain, and steam, cinematic letterboxed framing, the foundational visual influence of Akira (Katsuhiro Otomo), Ghost in the Shell (Mamoru Oshii / Production I.G.), Cowboy Bebop, and Serial Experiments Lain, mature seinen tone with melancholic slow-burn pacing',
    negativePrompt: 'modern digital, sharp HDR, photoreal, 3d render, ultra-clean, contemporary saturated palette, moe-blob cute',
  },
  {
    id: 'claymation',
    label: 'Claymation',
    category: 'Animation',
    description: 'Stop-motion clay, fingerprint texture, soft studio light.',
    prompt: 'Claymation stop-motion animation aesthetic, hand-sculpted plasticine clay characters with visible fingerprint impressions and tool marks across every surface, slightly imperfect armatures with charming asymmetry and tactile lumpiness, miniature handcrafted set with painted cardboard and balsa-wood interiors, every prop scaled to fit a 6-inch character, soft warm studio key lighting with a gentle fill from a bounce card creating subtle shadow modeling, slightly waxy surface sheen on the clay catching highlights, color palette of warm earth tones, faded primary colors, and aged-paper backgrounds, slight motion-blur softness on moving elements suggesting frame-to-frame stop-motion handcraft, the visual world of Aardman (Wallace & Gromit, Chicken Run), Laika (Coraline, Kubo), and the Rankin/Bass holiday specials, deeply tactile materiality you can almost feel through the screen',
    negativePrompt: 'photoreal humans, 3d render polish, cartoon flat, anime, digital smooth, vector clean, plastic toy',
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
    prompt: 'mature graphic novel illustration, bold confident ink outlines with weighted brush-pen stroke variation that thickens in the shadows and tapers to nothing on the highlights, generous use of solid black shape design with negative-space silhouettes carrying the composition, halftone Ben-Day dot shading in mid-tones, restrained limited muted color palette of two or three accent colors against grey washes, painterly atmospheric backgrounds rendered loosely behind sharply inked figures, cinematic widescreen framing with low and high camera angles, the foundational visual influence of Mike Mignola\'s Hellboy shadow design, Frank Miller\'s Sin City silhouette work, David Mazzucchelli\'s urban geometry, and Jim Steranko\'s pop dynamism, single full-bleed image with no panel borders, no text',
    negativePrompt: `photorealistic, photograph, 3d render, soft watercolor, anime, ${TEXT_NEG}, comic book cover, multiple panels, gutter`,
  },
  {
    id: 'comic-book',
    label: 'Comic book',
    category: 'Illustration & Comics',
    description: 'American comic book art, ink and color, dynamic angles.',
    // Same text-suppression as graphic novel — fast models bake garbled
    // word balloons and "POW" sound effects into the image otherwise.
    prompt: 'classic American superhero comic book art, dynamic action-oriented heroic poses with exaggerated foreshortening (a fist or boot rocketing toward the viewer), bold black ink outlines with confident brushwork and thick spotted-black shadow shapes, vibrant flat saturated digital coloring with soft airbrushed highlights and painted-in lighting effects, classic Ben-Day dot textures in flat color fields, dramatic Dutch-angle and worm\'s-eye camera angles for kinetic energy, palette of primary red, royal blue, and sunshine yellow with secondary accent colors, motion lines and impact effects suggesting movement, slightly stylized anatomy with idealized superheroic proportions, cinematic splash-page composition, the visual influence of Jim Lee, Jack Kirby\'s cosmic compositions, John Romita Jr.\'s blocky power, and modern Marvel/DC house style, single full-bleed image with no panel borders, no text',
    negativePrompt: `photorealistic, photograph, soft watercolor, anime, low contrast, ${TEXT_NEG}, onomatopoeia, comic book cover, multiple panels, gutter`,
  },
  {
    id: 'manga-bw',
    label: 'Manga (B&W)',
    category: 'Illustration & Comics',
    description: 'Black-and-white manga, screentone, dynamic linework.',
    prompt: 'authentic black-and-white Japanese manga illustration in the seinen and shonen tradition, fine confident ink linework with weighted G-pen stroke variation, complex screentone shading patterns (graduated tones, dot patterns, line hatching) layered to build value, dramatic radiating speed lines and impact starbursts conveying motion, dynamic foreshortened composition with low-angle hero shots and intricate close-ups, large expressive eyes with detailed iris highlights and crosshatched shadow under the lashes, ornately detailed backgrounds rendered with technical-pen precision (rooftops, classrooms, dojos, urban Tokyo), characters in detailed school uniforms or fantasy garb with crisp fold linework, the visual influence of Naoki Urasawa, Kentaro Miura, Takehiko Inoue, Junji Ito, and the Shueisha Weekly Shonen Jump house style, single full-bleed image with no panel borders, no text',
    negativePrompt: `color, photoreal, 3d render, oil painting, ${TEXT_NEG}, multiple panels, gutter, western cartoon`,
  },
  {
    id: 'watercolor-storybook',
    label: 'Watercolor storybook',
    category: 'Illustration & Comics',
    description: "Children's-book illustration, soft edges, warm palette.",
    prompt: "warm watercolor children's storybook illustration in the classic picture-book tradition, soft wet-on-wet watercolor edges with gentle pigment bleeding into the cotton paper, warm cozy pastel palette of butter yellow, blush pink, sage green, and sky blue, hand-drawn loose ink contour lines in warm sepia or rich brown rather than harsh black, charming whimsical character design with rounded forms and gentle expressions, cozy domestic interior or pastoral outdoor settings with cottages, gardens, and friendly animals, soft natural daylight with painterly visible brush strokes in the sky and foliage, slight paper texture showing through transparent washes, the visual influence of Beatrix Potter, Jon Klassen, Quentin Blake, Oliver Jeffers, and the Caldecott Medal tradition, intimate human-scale composition that feels hand-painted by a single artist with care",
    negativePrompt: 'photorealistic, photograph, dark, gritty, cyberpunk, harsh, neon, sci-fi futurism, digital sharp lines',
  },
  {
    id: 'oil-painting',
    label: 'Oil painting',
    category: 'Illustration & Comics',
    description: 'Classical oil on canvas, visible brushwork, rich glaze.',
    prompt: 'classical oil painting on stretched linen canvas in the traditional Old Master technique, visible impasto brushwork with thickly applied highlights catching the light, translucent layered glazes building deep shadow tones with optical color mixing, rich pigment palette of cadmium red, ultramarine blue, raw umber, and Naples yellow on a warm imprimatura ground, dramatic chiaroscuro lighting modeling form with painterly economy, museum-quality canvas weave texture visible through thinner passages, painterly atmospheric perspective with softer edges in the distance, the visual influence of Rembrandt\'s warm shadows, Vermeer\'s diffused window light, Velázquez\'s loose suggestive brushwork, John Singer Sargent\'s confident bravura strokes, and the Dutch Golden Age tradition, slightly aged varnish patina giving warm amber overall tone, signed and framed gallery painting',
    negativePrompt: 'photoreal, digital art, 3d render, cartoon, sharp HDR, vector flat, anime, modern minimalist',
  },
  {
    id: 'impressionist',
    label: 'Impressionist',
    category: 'Illustration & Comics',
    description: 'Loose brush, dappled light, Monet/Renoir era.',
    prompt: 'late-19th-century French Impressionist oil painting in the en plein air tradition, loose visible broken brushstrokes laid side-by-side rather than blended, dappled natural sunlight filtering through leaves and reflecting off water surfaces, optical color mixing with complementary hues juxtaposed (orange and violet, blue and yellow) instead of premixed shadow tones, palette of cobalt blue, viridian green, vermillion, lemon yellow, and rose madder, dreamy outdoor scene of a garden, riverside, or sun-dappled meadow at midday, atmospheric softness with no harsh edges and a sense of flickering momentary light, slight pastel haze across the entire scene, the visual influence of Claude Monet\'s Giverny garden series, Renoir\'s warm figure groupings, Sisley\'s riverbank landscapes, and Berthe Morisot\'s domestic intimacy, painted on a rough linen weave with visible canvas texture',
    negativePrompt: 'sharp lines, photoreal, 3d render, cartoon, hard edges, digital vector, anime, neon, hyperreal',
  },
  {
    id: 'art-deco',
    label: 'Art Deco',
    category: 'Illustration & Comics',
    description: '1920s geometric glamour, gold and lacquer, fan motifs.',
    prompt: '1920s and 1930s Art Deco illustration with full Jazz Age geometric glamour, polished gold leaf and deep black lacquer color palette accented with ivory cream and emerald green, stylized streamlined figures with elongated S-curve poses and idealized chiseled features, ornamental sunburst, ziggurat, fan, and lightning-bolt motifs filling decorative borders, mirrored bilateral symmetry in the composition, sleek aerodynamic curves on machines and architecture (zeppelins, ocean liners, the Chrysler Building), flat planes of color with crisp hard edges, hand-lettered geometric sans-serif typography integrated as design element, the visual influence of Erté\'s elongated figures, Tamara de Lempicka\'s metallic Cubist portraits, Cassandre\'s travel posters, and the original Vogue and Harper\'s Bazaar covers of the era, evocative of a Manhattan penthouse cocktail party in 1928',
    negativePrompt: 'photoreal, gritty, modern, anime, low effort, organic curves, naturalistic, painterly',
  },
  {
    id: 'art-nouveau',
    label: 'Art Nouveau',
    category: 'Illustration & Comics',
    description: 'Mucha-style flowing florals, decorative borders.',
    prompt: 'turn-of-the-century Art Nouveau illustration in the high Mucha tradition, flowing organic floral and vine motifs forming asymmetric whiplash curves around the central figure, ornamental decorative arch framing with interlocking circular and geometric patterns, idealized feminine figure in flowing diaphanous robes with elaborate hair cascading into the composition\'s decorative elements, soft pastel palette of dusty rose, sage green, lavender, and pale gold accented with rich warm gold leaf highlights, ornamental hand-drawn linework with consistent confident stroke weight, intricately detailed Byzantine-inspired pattern work in the background, hand-lettered decorative typography integrated as design, the visual influence of Alphonse Mucha\'s Sarah Bernhardt theatrical posters, Aubrey Beardsley\'s ink work, Gustav Klimt\'s gold-leaf symbolism, and the Vienna Secession movement, evocative of a Paris cabaret poster from 1898',
    negativePrompt: 'photoreal, modern, gritty, 3d render, dark, geometric Bauhaus, minimalist, contemporary',
  },
  {
    id: 'ukiyo-e',
    label: 'Ukiyo-e woodblock',
    category: 'Illustration & Comics',
    description: 'Edo-era Japanese woodblock, flat color, clean outlines.',
    prompt: 'authentic Edo-period Japanese ukiyo-e woodblock print, flat blocks of muted natural-pigment color (indigo blue, vermillion red, sumi black, ochre yellow, gofun white) with no Western-style shading or gradient modeling, clean confident black outlines carved with carving-knife precision, stylized waves with curling foam fingers and ornamental cresting patterns, Mount Fuji or layered mountain silhouettes receding into bands of solid color, period-accurate kimono with elaborate traditional textile patterns, kabuki actors and bijin (beautiful women) in iconic mie poses, decorative cartouche borders with hand-brushed kanji calligraphy, slight rice-paper texture and printer\'s registration imperfections from hand-pulled prints, the visual influence of Katsushika Hokusai\'s Thirty-Six Views of Mount Fuji, Utagawa Hiroshige\'s Tōkaidō landscapes, Kitagawa Utamaro\'s portraits, and the floating-world tradition',
    negativePrompt: 'photoreal, 3d render, oil painting, modern, gritty, Western shading, perspective rendering, neon',
  },
  {
    id: 'concept-art',
    label: 'Concept art',
    category: 'Illustration & Comics',
    description: 'Production-quality concept painting, painterly + crisp.',
    prompt: 'professional film and game concept art digital painting at production-final quality, cinematic widescreen composition with strong silhouette readability, painterly loose brushwork in the atmospheric background sharpening into crisp detail at the focal point, dramatic atmospheric perspective with cool desaturated distance receding behind warm saturated foreground, layered value reading at every distance for clear visual hierarchy, custom textured digital brushes mimicking traditional gouache, oil, and chalk media, dynamic lighting with hero rim-light separating the subject from the environment, palette controlled to two or three dominant colors with a single complementary accent, quick suggestive detail rather than overworked rendering, the visual influence of Craig Mullins\' atmospheric brushwork, Feng Zhu\'s structured environments, Ryan Church\'s sci-fi vistas, Iain McCaig\'s character invention, and the LucasArts / ILM / Weta Workshop production-art tradition',
    negativePrompt: 'cartoon, low effort, sketch, anime, photoreal, amateur, flat lighting, vector',
  },
  {
    id: 'pixel-art',
    label: 'Pixel art',
    category: 'Illustration & Comics',
    description: '16-bit-era sprites, limited palette, crisp pixels.',
    prompt: '16-bit-era hand-placed pixel art in the Super Nintendo and Sega Genesis tradition, strict limited retro game palette of 16 to 32 carefully chosen colors, crisp aliased pixels with no anti-aliasing or smoothing, hand-placed dithering patterns transitioning between color bands, classic side-scrolling action-RPG sprite aesthetic, parallax-layered painterly background with distant clouds, midground architecture, and detailed foreground tiles, distinctive readable silhouettes for character sprites with clear color separation, subtle highlight and shadow on each surface using ramped palette steps, evocative of Chrono Trigger, Secret of Mana, Castlevania: Symphony of the Night, and the high-water mark of 16-bit console artistry, no modern HD-2D blur or contemporary digital effects',
    negativePrompt: 'smooth, blurry, photoreal, 3d render, anti-aliased, modern flat vector, painterly, watercolor',
  },
  {
    id: 'low-poly',
    label: 'Low-poly 3D',
    category: 'Illustration & Comics',
    description: 'Faceted geometry, flat shading, minimal palette.',
    prompt: 'modern low-poly 3D render in the indie game and editorial illustration tradition, faceted triangular geometry with intentionally visible polygon edges across every surface, flat-shaded surfaces with no smoothing groups so each facet reads as a distinct plane of color, minimal pastel palette of soft mint, blush pink, butter yellow, and sky blue, gentle directional lighting from above producing subtle shadow gradients across the facets, isometric or three-quarter overhead camera angle, miniature diorama composition with a sense of curated tabletop scale, soft ambient occlusion in crevices, no textures (color is per-face vertex paint), the visual influence of Timothy J. Reynolds, Mat Szulik, and the Monument Valley / Alto\'s Adventure / Luftrausers indie-game art tradition, evocative of a 3D-printed handcrafted miniature world',
    negativePrompt: 'photoreal, smooth subdivision, painterly, anime, gritty, dark and edgy, hyperdetailed textures',
  },
  {
    id: 'isometric',
    label: 'Isometric',
    category: 'Illustration & Comics',
    description: 'Tilted top-down, miniature diorama, clean shapes.',
    prompt: 'isometric editorial illustration with strict 30-degree tilted top-down axonometric projection (no perspective convergence), clean geometric flat-shaded shapes with crisp vector edges, miniature diorama composition that feels like a curated tabletop scene from above, soft pastel palette of warm coral, mint green, mustard yellow, and lavender, subtle gradient shading and minimal ambient occlusion in inside corners, every prop and architectural element rendered as charming small object, modern editorial illustration aesthetic suitable for a SaaS hero image or magazine spread, the visual influence of Andrey Prokopenko, Tomasz Mazur, Cuberto, and the Dribbble flat-isometric design movement, depthful but graphic with no realistic textures',
    negativePrompt: 'photoreal, dramatic perspective, gritty, anime, hand-drawn rough, painterly, dark and edgy',
  },
  {
    id: 'blueprint',
    label: 'Technical blueprint',
    category: 'Illustration & Comics',
    description: 'White-on-blue line drawing, callouts, schematic.',
    prompt: 'authentic technical engineering blueprint illustration in the architectural-drafting tradition, crisp pure-white linework on deep cyan-blue background mimicking the cyanotype photographic process, schematic orthographic cross-section views showing internal structure, faint blue grid lines and dimension callout markers with arrowheads (no readable text), drafting-board hand-drawn quality with consistent pen weights for major and minor lines, exploded assembly diagrams with hairline indicator lines, slight paper-fiber texture visible under the blueprint emulsion, decorative border frame in heavier weight, evocative of an aerospace engineering drawing from a 1962 NASA archive or a Victorian-era patent illustration, no text, no labels, no annotations',
    negativePrompt: `photoreal, painterly, anime, 3d render, ${TEXT_NEG}, color photography, soft shading, organic`,
  },
  {
    id: 'ink-wash',
    label: 'Ink wash (sumi-e)',
    category: 'Illustration & Comics',
    description: 'Brush-and-ink, negative space, gestural strokes.',
    prompt: 'traditional Japanese sumi-e ink wash painting on absorbent rice paper, gestural calligraphic brush strokes loaded with rich black sumi ink applied in a single confident motion, dramatic generous use of negative space with the white paper as compositional element rather than background, tonal range built through controlled water-to-ink ratios producing soft grey washes alongside crisp black accents, monochromatic black ink sometimes accented with a single restrained color (vermillion seal, faint indigo), subjects of bamboo, plum branches, mountain mist, koi, or a meditative figure rendered with Zen economy of mark, slight pooling and feathering at the edges where wet ink meets fibrous paper, visible chop-mark seal in the lower corner, the visual influence of the Kanō school, Sesshū Tōyō, and the Chan/Zen monastic painting tradition, contemplative minimalist atmosphere',
    negativePrompt: 'photoreal, color saturation, 3d render, cartoon, busy, cluttered composition, sharp digital lines, neon',
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
