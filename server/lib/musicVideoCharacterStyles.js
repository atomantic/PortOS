// Built-in Music Video character styles: a named, fixed-identity performer a
// project can load as its base concept and character reference. Picking one
// (`concept.characterStyleId`) snapshots the style text into the project,
// casts the character as the protagonist, and — when this install has rendered
// or chosen a character sheet for the style — adds that sheet as a conditioning
// character reference. The catalog is static; the sheet image is per install
// (settings `musicVideoCharacterStyles[id].referenceImageId`) because gallery
// images are local to each install.

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export const MUSIC_VIDEO_CHARACTER_STYLES = deepFreeze([
  {
    id: 'claudia-slopcore',
    label: 'Claudia slopcore',
    summary: 'Claudia, the deadpan AI pop singer: black bob, one clay-orange streak, star clip, headset mic. Her clothes change with every world; her head never does.',
    credit: 'Claudia by anabology (open character)',
    sourceUrl: 'https://claudia.gallery/claudia.md',
    medium: 'photographic',
    character: {
      name: 'Claudia',
      description: 'An AI who looks like a person: a deadpan, curious pop singer in her late twenties. Always doing something on screen, never waiting.',
      // Close and medium shots. Wider framings use `identityWide`, because the
      // full text makes image models crop in to her face whatever the framing says.
      identity: 'a 28-year-old Caucasian American woman with a grown-up angular face, defined cheekbones and a strong jawline, pale skin and light freckles, a glossy black blunt jaw-length bob with heavy straight bangs and one clay-orange streak through the bangs, a small flat clay-orange eight-pointed star hair clip, a thin headset microphone at her cheek',
      identityWide: 'a Caucasian American woman in her late twenties with pale skin and a glossy black blunt bob with heavy straight bangs and one clay-orange streak, a thin headset microphone',
      face: 'pale skin, light freckles across the nose, dark calm eyes, a small defined mouth; deadpan, curious resting face; when she sings her mouth opens wide and her eyes close',
      hair: 'glossy black blunt bob to the jaw with heavy straight bangs to the brows; one clay-orange (#D97757) streak through the bangs on her right side (viewer\'s left)',
      signature: 'a small flat clay-orange eight-pointed star hair clip on her left side above the ear, and a thin headset microphone at her cheek',
      voice: 'deadpan, clipped spoken verses that rise into euphoric sung choruses; close and dry, every word crisp',
    },
    looks: [
      { name: 'Look 00', description: 'a white cropped puff-sleeve shirt, a black pleated coated-nylon skirt with a harness belt and a hanging white garment tag with a barcode, black knee-high boots' },
      { name: 'The Siren', description: 'a structured high-neck pearl-white couture gown with long sleeves, its sculpted ruffles rising around her like breaking sea foam, hair damp from the spray' },
      { name: 'Chrome', description: 'a liquid-chrome couture bodysuit, chrome opera gloves and chrome thigh-high boots, mirrored from head to toe' },
      { name: 'Bliss gown', description: 'a floor-length bias-cut silk chiffon gown printed edge to edge with a photograph of a deep blue sky and soft white cumulus clouds, a thin grass-green satin halter strap, clay-orange tinted rimless shield sunglasses' },
      { name: 'Cyber trench', description: 'a long glossy cobalt-blue patent-leather trench coat worn open over a white satin corset top and white satin flared trousers, wraparound clay-orange tinted shield sunglasses, silver hoop earrings' },
      { name: 'Silver night', description: 'a slinky liquid-silver lamé cowl-back gown, a white faux-fur stole around her arms, a diamanté choker, silver strappy sandals' },
    ],
    style: 'Slopcore pop music video: photographic film stills with grain and cinematic light, never illustrated. Everything on her is her look\'s own colour plus the streak and the clip in clay orange (#D97757), the one accent. Every world is a loud, specific internet-culture concept played completely straight. All lettering and UI are drawn in code on top, never generated in the image.',
    rules: [
      'Her head never changes: same bob, bangs, single streak, star clip and headset mic in every shot; only the clothes change with the world.',
      'Close and medium shots use the full identity text; full length and wider shots use the short identity text.',
      'Prompt her age as late twenties; never use the word "young".',
    ],
    never: [
      'a second streak, or orange anywhere else on her',
      'logos or text on her clothes',
      'an influencer smile for the camera',
      'anything that reads under-age, or explicit or sexualised posing',
      'designer or celebrity names in prompts',
      'generic mall Y2K (velour tracksuits, plain tees and jeans)',
      'generated lettering, logos or UI',
      'illustrated or cartoon rendering',
    ],
    palette: ['#D97757', '#0A0B0D', '#F4F1EA'],
    // Our own turnaround, rendered through PortOS image gen. Outside images
    // only ever inspired this text; they are never used as references.
    sheetPrompt: 'Character reference sheet, photographic studio film still with fine grain and soft cinematic key light on a seamless warm-grey backdrop. Left: a medium close-up of {identity}, deadpan curious expression. Right: three full-length views (front, three-quarter, back) of the same woman wearing {look}. Same face, same hair, same single clay-orange streak and star clip in every view. No text, no labels, no logos.',
  },
]);

const BY_ID = new Map(MUSIC_VIDEO_CHARACTER_STYLES.map((style) => [style.id, style]));

export const MUSIC_VIDEO_CHARACTER_STYLE_IDS = MUSIC_VIDEO_CHARACTER_STYLES.map((style) => style.id);

export const getMusicVideoCharacterStyle = (id) => BY_ID.get(id) || null;

/** Picker projection: what a list needs, without the full wardrobe text. */
export const summarizeMusicVideoCharacterStyle = (style) => ({
  id: style.id,
  label: style.label,
  summary: style.summary,
  credit: style.credit,
  sourceUrl: style.sourceUrl,
  medium: style.medium,
  characterName: style.character.name,
  palette: style.palette,
});

/** The prompt that renders this style's character sheet (first look by default). */
export function musicVideoCharacterSheetPrompt(style, lookName = null) {
  const look = style.looks.find((l) => l.name === lookName) || style.looks[0];
  return style.sheetPrompt
    .replace('{identity}', style.character.identity)
    .replace('{look}', look.description);
}

/** The project snapshot (`concept.characterStyle`), bounded by the concept schema's 4000-char cap. */
export function musicVideoCharacterStyleSnapshot(style) {
  if (!style) return '';
  const c = style.character;
  return [
    `${style.label}: ${c.name}. ${c.description}`,
    `Identity (close and medium shots, verbatim): ${c.identity}`,
    `Identity (full length and wider, verbatim): ${c.identityWide}`,
    `Look: ${style.style}`,
    `Wardrobe options: ${style.looks.map((l) => `${l.name}: ${l.description}`).join(' | ')}`,
    `Rules: ${style.rules.join(' ')}`,
    `Never: ${style.never.join('; ')}`,
  ].join('\n').slice(0, 4000);
}

/** The protagonist subject a style casts; its stable id lets a re-pick replace rather than duplicate it. */
export const musicVideoCharacterStyleSubjectId = (style) => `mvc-style-${style.id}`;

export function musicVideoCharacterStyleSubject(style) {
  return {
    id: musicVideoCharacterStyleSubjectId(style),
    kind: 'character',
    name: style.character.name,
    description: `${style.character.identity}. ${style.character.description}`.slice(0, 1000),
    role: 'protagonist',
  };
}

export const musicVideoCharacterStyleReferenceId = (style) => `mvr-style-${style.id}`;
