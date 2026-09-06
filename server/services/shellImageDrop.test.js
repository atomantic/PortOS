import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shell.js', () => ({
  getSession: vi.fn(),
  pasteToSession: vi.fn(() => true),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { screenshots: '/opt/portos/data/screenshots' },
  saveImageUpload: vi.fn(),
  unlinkGuarded: vi.fn().mockResolvedValue(undefined),
}));

import { buildImageDropText, dropImageIntoShellSession } from './shellImageDrop.js';
import { getSession, pasteToSession } from './shell.js';
import { saveImageUpload, PATHS } from '../lib/fileUtils.js';

const SESSION_ID = 'session-abcdef123456';
const STORED = 'shell-aa11bb22-photo.jpg';
const IMAGE_PATH = `${PATHS.screenshots}/${STORED}`;
const upload = { sessionId: SESSION_ID, filename: 'photo.jpg', data: 'Zm9v' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(getSession).mockReturnValue({ _id: 'session-' });
  vi.mocked(pasteToSession).mockReturnValue(true);
  vi.mocked(saveImageUpload).mockResolvedValue({ filename: STORED, filePath: IMAGE_PATH, size: 3 });
});

describe('buildImageDropText', () => {
  it('preserves a multi-line message as one payload', () => {
    expect(buildImageDropText('/tmp/a.png', 'first\nsecond'))
      .toBe('first\nsecond\n/tmp/a.png');
  });

  it('treats a whitespace-only message as no message', () => {
    expect(buildImageDropText('/tmp/a.png', '   ')).toBe('/tmp/a.png');
  });

  it('single-quotes a path containing whitespace', () => {
    expect(buildImageDropText('/tmp/my shots/a.png', 'look'))
      .toBe("look\n'/tmp/my shots/a.png'");
  });

  it('escapes an embedded single quote POSIX-style', () => {
    expect(buildImageDropText("/tmp/adam's shots/a.png"))
      .toBe("'/tmp/adam'\\''s shots/a.png'");
  });
});

describe('dropImageIntoShellSession', () => {
  it('saves the image and pastes message + absolute path, answering with the stored name', async () => {
    const result = await dropImageIntoShellSession({ ...upload, message: 'describe this' });

    // The stored name is uniquified — a phone camera roll repeats `IMG_0001.jpg`,
    // and a second drop must not overwrite bytes the agent hasn't read yet.
    expect(saveImageUpload).toHaveBeenCalledWith(
      PATHS.screenshots,
      { filename: expect.stringMatching(/^shell-[0-9a-f]{8}-photo\.jpg$/), data: 'Zm9v' },
      { maxBytes: expect.any(Number) },
    );
    expect(pasteToSession).toHaveBeenCalledWith(
      SESSION_ID,
      `describe this\n${IMAGE_PATH}`,
      { label: 'image drop' },
    );
    // The absolute path must never come back over the wire.
    expect(result).toEqual({ sessionId: SESSION_ID, filename: STORED });
  });

  it('pastes the bare path when there is no message', async () => {
    await dropImageIntoShellSession(upload);
    expect(pasteToSession).toHaveBeenCalledWith(SESSION_ID, IMAGE_PATH, { label: 'image drop' });
  });

  // Checking the session first means a stale id can't leave an orphan file behind.
  it('404s before writing anything when the session is gone', async () => {
    vi.mocked(getSession).mockReturnValue(null);
    await expect(dropImageIntoShellSession(upload)).rejects.toThrow('Session not found');
    expect(saveImageUpload).not.toHaveBeenCalled();
    expect(pasteToSession).not.toHaveBeenCalled();
  });

  it('404s when the session dies while the bytes are being written', async () => {
    vi.mocked(pasteToSession).mockReturnValue(false);
    await expect(dropImageIntoShellSession(upload)).rejects.toThrow('Session not found');
  });

  // saveImageUpload owns the size cap and the magic-byte sniff; its 400 bubbles.
  it('lets a rejected upload bubble instead of pasting', async () => {
    vi.mocked(saveImageUpload).mockRejectedValue(new Error('Invalid image file'));
    await expect(dropImageIntoShellSession(upload)).rejects.toThrow('Invalid image file');
    expect(pasteToSession).not.toHaveBeenCalled();
  });
});
