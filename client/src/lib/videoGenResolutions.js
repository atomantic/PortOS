// Shared resolution presets for video generation. Companion to
// `imageGenResolutions.js` — both pages drive a "preset dropdown + custom
// fallback" pattern off these tables so the size dropdown stays consistent.
//
// Video sizes follow LTX-2's preferred latent boundaries (multiples of 32 on
// each edge); the aspect-ratio hints in the labels surface common shapes the
// user picks for (16:9 social, 2:3 portrait, 1:1 grid).
export const VIDEO_RESOLUTIONS = [
  { label: '512×320 (16:10)', w: 512, h: 320 },
  { label: '640×384 (5:3)', w: 640, h: 384 },
  { label: '704×448 (16:10)', w: 704, h: 448 },
  { label: '768×512 (3:2 default)', w: 768, h: 512 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '512×768 (portrait)', w: 512, h: 768 },
  { label: '512×512 (1:1)', w: 512, h: 512 },
  { label: '768×768 (1:1)', w: 768, h: 768 },
];
