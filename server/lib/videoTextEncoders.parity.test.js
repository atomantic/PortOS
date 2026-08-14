/**
 * Cross-package parity for the swappable prompt-conditioner sentinel (#4081).
 *
 * Unlike the IC-LoRA registry next door, the OPTIONS themselves are not
 * mirrored — the server decorates each model entry with its own
 * `textEncoderOptions` (videoGen/local.js#decorateVideoModel), so the picker
 * renders whatever this build's runner can key-map and there is nothing on the
 * client to drift.
 *
 * The one duplicated value is the "no override" sentinel, and it carries real
 * weight in both directions: the client's submit builder DROPS the field when
 * it holds this value, and the server treats an absent field and this id
 * identically (`isStockTextEncoder`). If the two strings ever diverged, the
 * client would post `textEncoderId: 'stock'` to a server that reads it as a
 * substitute id and 400s VIDEO_TEXT_ENCODER_UNSUPPORTED on every H3 render.
 *
 * Lives server-side because the server module can't load under the client
 * (jsdom) runner, while the pure client mirror loads fine here.
 */

import { describe, it, expect } from 'vitest';
import { STOCK_TEXT_ENCODER_ID, isStockTextEncoder, videoTextEncoderOptions } from './videoTextEncoders.js';
import {
  STOCK_TEXT_ENCODER_ID as CLIENT_STOCK_TEXT_ENCODER_ID,
  normalizeTextEncoderForModel,
  textEncoderIdFromRecord,
} from '../../client/src/lib/videoGenParams.js';

describe('video text-encoder client/server parity', () => {
  it('mirrors the stock sentinel exactly', () => {
    expect(CLIENT_STOCK_TEXT_ENCODER_ID).toBe(STOCK_TEXT_ENCODER_ID);
  });

  // The client emits this value in three places (initial state, the
  // model-change reset, the record restore). Every one of them must land on
  // something the server reads as "no override".
  it('produces a sentinel the server accepts as no-override', () => {
    expect(isStockTextEncoder(CLIENT_STOCK_TEXT_ENCODER_ID)).toBe(true);
    expect(isStockTextEncoder(textEncoderIdFromRecord(undefined))).toBe(true);
    expect(isStockTextEncoder(textEncoderIdFromRecord(''))).toBe(true);
    expect(isStockTextEncoder(normalizeTextEncoderForModel('gone', { runtime: 'minimax_h3' }))).toBe(true);
  });

  // The server ships the true option list (including a lone built-in entry), so
  // the client's normalizer has to agree that a stock-only model offers no
  // substitute to select.
  it('agrees that the built-in option is the stock sentinel', () => {
    const options = videoTextEncoderOptions({ runtime: 'minimax_h3' });
    const builtIn = options.filter((option) => option.builtIn);
    expect(builtIn).toHaveLength(1);
    expect(builtIn[0].id).toBe(CLIENT_STOCK_TEXT_ENCODER_ID);

    // A substitute the model really offers survives normalization unchanged.
    const substitute = options.find((option) => !option.builtIn);
    const model = { runtime: 'minimax_h3', textEncoderOptions: options };
    expect(normalizeTextEncoderForModel(substitute.id, model)).toBe(substitute.id);
  });
});
