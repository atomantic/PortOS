import { describe, expect, it } from 'vitest';
import {
  buildDownloadUrl, TEXT_ENCODER_DOWNLOAD_ID, textEncoderDownloadId,
} from './useModelDownloadStatus.js';

describe('buildDownloadUrl', () => {
  it('builds a plain model download URL', () => {
    // A restricted model's license acknowledgement is NOT a query parameter —
    // the server resolves it from the install record, so a download can't be
    // self-authorized by whoever builds this URL.
    expect(buildDownloadUrl('video', 'minimax_h3_8bit')).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download',
    );
  });

  it('adds the repair force flag without changing special routes', () => {
    expect(buildDownloadUrl('video', 'minimax_h3_8bit', true)).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download?force=1',
    );
    expect(buildDownloadUrl('video', TEXT_ENCODER_DOWNLOAD_ID, true)).toBe(
      '/api/video-gen/text-encoder/download?force=1',
    );
  });

  // Substitutable prompt conditioners (#4081) route to their own lane, and the
  // SHARED install-wide encoder keeps its separate scalar route — the two must
  // not collapse into one another.
  it('routes a substitutable text encoder to the per-id lane', () => {
    expect(buildDownloadUrl('video', textEncoderDownloadId('heretic-bf16'))).toBe(
      '/api/video-gen/text-encoders/heretic-bf16/download',
    );
    expect(buildDownloadUrl('video', textEncoderDownloadId('heretic-bf16'), true)).toBe(
      '/api/video-gen/text-encoders/heretic-bf16/download?force=1',
    );
  });

  // Routing keys on the namespace prefix, not the bare id, so a registry model
  // that ever shared an encoder's name can't be misrouted into the encoder lane.
  it('does not treat a bare encoder-shaped model id as an encoder', () => {
    expect(buildDownloadUrl('video', 'heretic-bf16')).toBe(
      '/api/video-gen/models/heretic-bf16/download',
    );
  });

  it('leaves image-gen ids on the model lane whatever they are named', () => {
    expect(buildDownloadUrl('image', textEncoderDownloadId('heretic-bf16'))).toBe(
      `/api/image-gen/models/${encodeURIComponent(textEncoderDownloadId('heretic-bf16'))}/download`,
    );
  });
});
