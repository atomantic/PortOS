/** Greybox previz limits and vocabulary (lib/musicVideoPreviz.js), a leaf so validation stays narrow. */
export const PREVIZ_CUTS_MAX = 600;
export const PREVIZ_TRACKS_MAX = 240;
export const PREVIZ_KEYS_MAX = 2000;
export const PREVIZ_VISIBLE_MAX = 24;
// How a figure is posed on a key: standing, or riding a bike (drawn as a long, low bike proxy under a seated figure).
export const PREVIZ_POSES = Object.freeze(['stand', 'ride']);
// Pawn colors with plain names, so a person (and later a model told "the lavender figure is Ana") can tell who is who.
// New cast members take them in order; the director can repick any.
export const PREVIZ_PAWN_COLORS = Object.freeze([
  { id: 'red', label: 'Red', hex: '#d64545' },
  { id: 'sky-blue', label: 'Sky blue', hex: '#4aa3e8' },
  { id: 'yellow', label: 'Yellow', hex: '#e8c93a' },
  { id: 'green', label: 'Green', hex: '#4cb860' },
  { id: 'lavender', label: 'Lavender', hex: '#b39ddb' },
  { id: 'orange', label: 'Orange', hex: '#ec8a35' },
  { id: 'pink', label: 'Pink', hex: '#ea7fb5' },
  { id: 'teal', label: 'Teal', hex: '#2fa59a' },
  { id: 'white', label: 'White', hex: '#f2f2f2' },
  { id: 'brown', label: 'Brown', hex: '#8a5a3c' },
  { id: 'navy', label: 'Navy', hex: '#2c3e8f' },
  { id: 'black', label: 'Black', hex: '#222222' },
  { id: 'heather-gray', label: 'Heather gray', hex: '#a3a6ab' },
  { id: 'chrome', label: 'Chrome', hex: '#d9dde3' },
]);
export const PREVIZ_PAWN_COLOR_IDS = Object.freeze(PREVIZ_PAWN_COLORS.map((color) => color.id));
