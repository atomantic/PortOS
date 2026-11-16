/**
 * Single source of truth for the CoS avatar-style vocabulary: `AVATAR_STYLES` (`{id, label, webgl}`),
 * `AVATAR_STYLE_IDS` (the `avatarStyle` zod enum), `AVATAR_STYLE_LABELS`, `WEBGL_AVATAR_STYLE_IDS`.
 *
 * Every consumer derives from `AVATAR_STYLES`. `webgl: true` marks a style needing the three.js
 * stage; the 2D `core` canvas and inline `svg`/`ascii` styles are `webgl: false`. Lives
 * server-side because the client imports pure `server/lib` leaves, never the reverse;
 * `client/src/lib/avatarStyles.js` re-exports it.
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
