/** Shared Music Video snapshot treatment choices, defaults, and asset lookup. */

import { musicVideoAspect } from './musicVideoAspect.js';

export const IMAGE_TREATMENT_PRESETS = Object.freeze({
  quartz: {
    label: 'Quartz Date Imprint (1980s–1990s)',
    description: 'Soft seven-segment numerals exposed into the negative. Bright areas can wash out the imprint.',
    date: '1985-07-14', format: 'ymd', position: 'bottom-right', color: '#ff8528', size: 0.045, opacity: 0.88, intensity: 0.6,
  },
  early: {
    label: 'Early Camera Date Imprint (1970s)',
    description: 'Small block numerals inspired by manually set optical data backs, rather than a quartz LCD.',
    date: '1975-07-14', format: 'ymd', position: 'bottom-right', color: '#ffb45c', size: 0.035, opacity: 0.8, intensity: 0.38,
  },
  print: {
    label: 'Photofinisher Date Stamp (1960s–1990s)',
    description: 'A lab-style processing date on the white print border. Use the development date, not necessarily the day it was taken.',
    date: '1975-07-14', format: 'month-year', position: 'bottom-left', color: '#49443c', size: 0.032, opacity: 0.82, intensity: 0.24,
  },
});

export const IMAGE_TREATMENT_FORMATS = Object.freeze({
  ymd: 'YY M D', mdy: 'M D YY', dmy: 'D M YY', 'month-year': 'MMM YYYY', 'full-date': 'MMM D YYYY',
});
export const IMAGE_TREATMENT_POSITIONS = Object.freeze({
  'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'top-right': 'Top right', 'top-left': 'Top left',
});
export const IMAGE_TREATMENT_RANGES = Object.freeze({ size: [0.018, 0.12], opacity: [0, 1], intensity: [0, 1] });
export const IMAGE_TREATMENT_LIMIT = 128;

export function imageTreatmentDefaults(type, imageId) {
  const preset = Object.hasOwn(IMAGE_TREATMENT_PRESETS, type) ? IMAGE_TREATMENT_PRESETS[type] : null;
  if (!preset) return null;
  const { label: _label, description: _description, ...settings } = preset;
  return { imageId, type, ...settings };
}

export function shotImageTreatment(scene, imageId) {
  return imageId && Array.isArray(scene?.imageTreatments)
    ? scene.imageTreatments.find((item) => item.imageId === imageId) || null : null;
}

// Keep a treatment attached to its image when the director switches takes,
// swaps start/end, or reorders a sequence. A replacement has its own settings.
export function shotTreatmentImages(scene) {
  const images = new Map();
  const add = (id, label) => { if (id && !images.has(id)) images.set(id, label); };
  add(scene?.referenceImageId, 'Start frame');
  add(scene?.endImageId, 'End frame');
  scene?.photoSequence?.imageIds?.forEach((id, i) => add(id, `Photo ${i + 1}`));
  (scene?.takes || []).forEach((take, i) => {
    if (take.kind === 'image' || take.kind === 'endImage') add(take.assetId, take.originalName || `Frame take ${i + 1}`);
  });
  return [...images].map(([id, label]) => ({ id, label }));
}

// Individual laid-out photographs are already fitted whole by the stack.
export function shotImageTreatmentAspect(project, scene, imageId) {
  const sequence = scene?.visualLayer === 'still' && scene.photoSequence?.enabled !== false ? scene.photoSequence : null;
  const layerIndices = (sequence?.imageIds || []).flatMap((id, index) => id === imageId ? [index] : []);
  const fittedByLayout = layerIndices.length && layerIndices.every(index => sequence.layouts?.[index]);
  return fittedByLayout && scene.referenceImageId !== imageId && scene.endImageId !== imageId ? null : musicVideoAspect(project);
}

export function isImageTreatmentDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const dt = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === date;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function imageTreatmentDateText({ type, date, format }) {
  const [yyyy, mm, dd] = date.split('-');
  const month = MONTHS[Number(mm) - 1];
  const y = yyyy.slice(2);
  const m = Number(mm);
  const d = Number(dd);
  if (format === 'month-year') return `${month} ${yyyy}`;
  if (format === 'full-date') return `${month} ${d} ${yyyy}`;
  if (format === 'mdy') return `${m} ${d} ${y}`;
  if (format === 'dmy') return `${d} ${m} ${y}`;
  return type === 'quartz' ? `'${y} ${m} ${d}` : `${y} ${m} ${d}`;
}
