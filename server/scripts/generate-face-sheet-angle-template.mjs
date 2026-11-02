#!/usr/bin/env node
/** Rebuild the shipped face-angle diagram; no provider or instance data is used. */
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FACE_SHEET_ANGLE_TEMPLATE, faceSheetAngleTemplateSvg } from '../lib/faceSheetAngleTemplate.js';

const output = fileURLToPath(new URL(`../../data.reference/templates/${FACE_SHEET_ANGLE_TEMPLATE}`, import.meta.url));
await sharp(Buffer.from(faceSheetAngleTemplateSvg())).png().toFile(output);
console.log(`✅ Generated ${FACE_SHEET_ANGLE_TEMPLATE}`);
