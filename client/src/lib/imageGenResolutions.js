// Shared resolution presets for image generation. Used by the standalone
// Image Gen page and the World Builder batch render so the size dropdown
// stays consistent everywhere.
export const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '768×512', w: 768, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×768', w: 768, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216 },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
];

export const findResolution = (w, h) => RESOLUTIONS.find((r) => r.w === w && r.h === h);
