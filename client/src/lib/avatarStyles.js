/**
 * Single source of truth for the CoS avatar-style vocabulary. Every consumer
 * that used to hand-maintain its own list derives from `AVATAR_STYLES`
 * instead (#6253): the picker labels (`components/cos/constants.js`), the
 * lazy-load map and WebGL-stage set (`pages/ChiefOfStaff.jsx`), and the
 * server's `avatarStyle` zod enum (`server/routes/cosStatusRoutes.js`,
 * imported directly — this leaf has no transitive deps, so it's safe from
 * the server workspace the way `personaTraitBlend.js`'s `clamp` import is).
 *
 * `webgl: true` marks a style that needs the three.js canvas stage —
 * `CANVAS_AVATAR_STYLES` derives from this flag. The 2D `core` canvas style
 * and the inline `svg`/`ascii` styles are deliberately `webgl: false`.
 */

export const AVATAR_STYLES = [
  { id: 'svg', label: 'Digital (SVG)', webgl: false },
  { id: 'cyber', label: 'Cyberpunk (3D)', webgl: true },
  { id: 'sigil', label: 'Arcane Sigil (3D)', webgl: true },
  { id: 'esoteric', label: 'Esoteric (3D)', webgl: true },
  { id: 'nexus', label: 'Neural Nexus (3D)', webgl: true },
  { id: 'muse', label: 'Cyber Muse (3D)', webgl: true },
  // Kestrel Neon's rotating wireframe icosahedron — 2D canvas, no WebGL needed.
  { id: 'core', label: 'Core Assembly (Canvas)', webgl: false },
  // Bundled CC0 Kenney Mini Characters — animated rigged GLB avatars.
  { id: 'miniMaleC', label: 'Mini Character — Male (3D)', webgl: true },
  { id: 'miniFemaleD', label: 'Mini Character — Female (3D)', webgl: true },
  { id: 'ascii', label: 'Minimalist (ASCII)', webgl: false },
];

export const AVATAR_STYLE_IDS = AVATAR_STYLES.map((style) => style.id);

export const AVATAR_STYLE_LABELS = Object.fromEntries(
  AVATAR_STYLES.map((style) => [style.id, style.label])
);

export const WEBGL_AVATAR_STYLE_IDS = new Set(
  AVATAR_STYLES.filter((style) => style.webgl).map((style) => style.id)
);
