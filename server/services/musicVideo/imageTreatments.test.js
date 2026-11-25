import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { imageTreatmentDateText, imageTreatmentDefaults } from '../../lib/musicVideo/musicVideoImageTreatments.js';
import { renderImageTreatment } from './imageTreatments.js';

const size = { width: 640, height: 360 };
const photo = background => sharp({ create: { ...size, channels: 3, background } }).png().toBuffer();
const pixels = buffer => sharp(buffer).removeAlpha().raw().toBuffer();
const changed = async (a, b) => {
  const first = await pixels(a);
  const second = await pixels(b);
  return first.reduce((total, value, i) => total + Math.abs(value - second[i]), 0);
};
const pick = (raw, x, y) => [...raw.subarray((y * size.width + x) * 3, (y * size.width + x) * 3 + 3)];

describe('snapshot treatments', () => {
  it('renders deterministic, exposure-sensitive optical lettering only in the picked corner', async () => {
    const source = await photo('#151515');
    const light = await photo('#f9f9f9');
    const settings = imageTreatmentDefaults('quartz', 'a.png');
    const darkStamp = await renderImageTreatment(source, settings);
    expect(darkStamp.equals(await renderImageTreatment(source, settings))).toBe(true);
    expect(await changed(source, darkStamp)).toBeGreaterThan(15_000);
    expect(await changed(light, await renderImageTreatment(light, settings))).toBeLessThan((await changed(source, darkStamp)) / 3);
    expect(pick(await pixels(darkStamp), 10, 10)).toEqual([21, 21, 21]);
    const early = await renderImageTreatment(source, { ...settings, type: 'early' });
    expect(await changed(early, darkStamp)).toBeGreaterThan(5_000);
    expect((await renderImageTreatment(source, null))).toBe(source);
  });

  it('fits a 4:3 print whole into a widescreen delivery frame without losing the stamp', async () => {
    const source = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#21314a' } }).png().toBuffer();
    const preset = imageTreatmentDefaults('print', 'a.png');
    const widescreen = await renderImageTreatment(source, preset, { aspect: '16:9' });
    const paper = await renderImageTreatment(source, { ...preset, opacity: 0 }, { aspect: '16:9' });
    expect(await sharp(widescreen).metadata()).toMatchObject({ width: 853, height: 480 });
    expect(await changed(widescreen, paper)).toBeGreaterThan(3_000);
    const raw = await pixels(widescreen);
    expect([...raw.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...raw.subarray(107 * 3, 108 * 3)]).toEqual([250, 248, 241]);
  });

  it('places a monochrome date on paper and fits the entire image inside the unchanged aspect', async () => {
    const source = await photo('#335577');
    const preset = imageTreatmentDefaults('print', 'a.png');
    const print = await renderImageTreatment(source, { ...preset, format: 'full-date', date: '1964-06-20' });
    const raw = await pixels(print);
    expect(pick(raw, 0, 0)).toEqual([250, 248, 241]);
    expect(pick(raw, 320, 180)).toEqual([51, 85, 119]);
    expect(await sharp(print).metadata()).toMatchObject(size);
    const paperOnly = await renderImageTreatment(source, { ...preset, opacity: 0 });
    expect(await changed(print, paperOnly)).toBeGreaterThan(3_000);
    expect(imageTreatmentDateText(preset)).toBe('JUL 1975');
    expect(imageTreatmentDateText({ ...preset, format: 'dmy' })).toBe('14 7 75');
  });
});
