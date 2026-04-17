// Curated Piper voice catalog — small, hand-picked set for comparison against
// Kokoro. These are ONNX voices from https://huggingface.co/rhasspy/piper-voices.
// Each entry maps to `<lang>/<locale>/<speaker>/<quality>/<id>.onnx` on HF.
//
// `speakerId` is used with multi-speaker models (VCTK). Piper accepts it via
// `--speaker <id>`. Indices follow the VCTK speaker-sorted order baked into
// the rhasspy Piper VCTK checkpoint (p225=0 … p376=108), so 39 ≈ p266, a known
// Irish female. Changing this index lets you audition other VCTK speakers.

export const PIPER_VOICES = Object.freeze([
  {
    id: 'en_GB-jenny_dioco-medium',
    gender: 'Female',
    accent: 'British (Jenny Dioco)',
    note: 'Clean, neutral British female',
    sizeMB: 63,
  },
  {
    id: 'en_GB-southern_english_female-low',
    gender: 'Female',
    accent: 'Southern English',
    note: 'Low-quality model, small + fast',
    sizeMB: 28,
  },
  {
    id: 'en_GB-cori-high',
    gender: 'Female',
    accent: 'British (Cori, high)',
    note: 'Highest-quality Piper English female',
    sizeMB: 115,
  },
  {
    id: 'en_GB-alba-medium',
    gender: 'Female',
    accent: 'Scottish (Alba)',
    note: 'Closest Piper has to a non-English UK regional',
    sizeMB: 63,
  },
  {
    id: 'en_GB-vctk-medium',
    gender: 'Female',
    accent: 'Irish (VCTK p266)',
    note: 'Multi-speaker VCTK; speakerId picks the accent',
    speakerId: 39,
    sizeMB: 75,
  },
  {
    id: 'en_US-amy-medium',
    gender: 'Female',
    accent: 'American (Amy)',
    note: 'US comparison baseline',
    sizeMB: 63,
  },
]);

export const findPiperVoice = (id) => PIPER_VOICES.find((v) => v.id === id) || null;
