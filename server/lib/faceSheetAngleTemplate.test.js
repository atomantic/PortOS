import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { FACE_SHEET_ANGLE_TEMPLATE, faceSheetAngleTemplateSvg } from './faceSheetAngleTemplate.js';

describe('shipped face-sheet angle guide', () => {
  // A repeated or reversed 3/4 nose would teach every generated face sheet the wrong angle.
  it('ships the generated 2×5 guide with front, image-left and image-right noses', async () => {
    const shipped = await readFile(new URL(`../../data.reference/templates/${FACE_SHEET_ANGLE_TEMPLATE}`, import.meta.url));
    const generated = await sharp(Buffer.from(faceSheetAngleTemplateSvg())).png().toBuffer();
    for (const image of [shipped, generated]) {
      const pixels = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(pixels.info).toMatchObject({ width: 1600, height: 640, channels: 3 });
      const pixel = (x, y) => [...pixels.data.subarray((y * 1600 + x) * 3, (y * 1600 + x) * 3 + 3)];
      expect(pixel(160, 151)).toEqual([221, 221, 221]);
      for (const [column, direction, reach] of [[1, -1, 60], [2, -1, 70], [3, 1, 60], [4, 1, 70]]) {
        const center = column * 320 + 160;
        expect(pixel(center + direction * reach, 150)).toEqual([204, 204, 204]);
        expect(pixel(center - direction * reach, 150)).not.toEqual([204, 204, 204]);
        expect(pixel(center + direction * 42, 284)).toEqual([255, 212, 59]);
        expect(pixel(center - direction * 42, 284)).toEqual([37, 37, 37]);
      }
    }
  });
});
