import { describe, it, expect } from 'vitest';

import { EXTENSION_MIME_MAP, ATTACHMENT_ALLOWED_EXTENSIONS, getMimeType, detectImageFormat, getFileExtension, sanitizeFilename } from './mimeTypes.js';

// =============================================================================
// sanitizeFilename / getFileExtension / getMimeType / allowlists (#1140)
// =============================================================================

describe('sanitizeFilename', () => {
  it('returns a safe basename for a normal filename', () => {
    expect(sanitizeFilename('hello.txt')).toBe('hello.txt');
  });

  it('strips directory components', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('replaces special characters with underscores', () => {
    expect(sanitizeFilename('hello world!.txt')).toBe('hello_world_.txt');
    expect(sanitizeFilename('file with spaces.js')).toBe('file_with_spaces.js');
    expect(sanitizeFilename('résumé.pdf')).toBe('r_sum_.pdf');
  });

  it('prevents hidden files by replacing a leading dot', () => {
    expect(sanitizeFilename('.bashrc')).toBe('_bashrc');
    expect(sanitizeFilename('.hidden.txt')).toBe('_hidden.txt');
  });

  it('leaves dots in the middle alone (extension dots)', () => {
    expect(sanitizeFilename('my.file.name.txt')).toBe('my.file.name.txt');
  });

  it('handles an empty string gracefully', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});

describe('getFileExtension', () => {
  it('returns the lowercased extension with leading dot', () => {
    expect(getFileExtension('photo.PNG')).toBe('.png');
    expect(getFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('returns null for a filename without an extension', () => {
    expect(getFileExtension('Makefile')).toBeNull();
    expect(getFileExtension('no-ext')).toBeNull();
  });

  it('normalises uppercase extensions', () => {
    expect(getFileExtension('IMAGE.JPEG')).toBe('.jpeg');
  });
});

describe('getMimeType', () => {
  it('returns the correct MIME type for known extensions', () => {
    expect(getMimeType('.png')).toBe('image/png');
    expect(getMimeType('.pdf')).toBe('application/pdf');
    expect(getMimeType('.mp3')).toBe('audio/mpeg');
    expect(getMimeType('.zip')).toBe('application/zip');
    expect(getMimeType('.json')).toBe('application/json');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(getMimeType('.xyz')).toBe('application/octet-stream');
    expect(getMimeType('.unknown')).toBe('application/octet-stream');
    expect(getMimeType(null)).toBe('application/octet-stream');
  });

  it('all entries in EXTENSION_MIME_MAP are reachable through getMimeType', () => {
    for (const [ext, mime] of Object.entries(EXTENSION_MIME_MAP)) {
      expect(getMimeType(ext)).toBe(mime);
    }
  });
});

describe('ATTACHMENT_ALLOWED_EXTENSIONS', () => {
  it('is a Set', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS).toBeInstanceOf(Set);
  });

  it('allows common document types', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.pdf')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.md')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.json')).toBe(true);
  });

  it('allows image types', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.png')).toBe(true);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.jpg')).toBe(true);
  });

  it('does NOT allow audio/video types (strict attachment subset)', () => {
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.mp3')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.mp4')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.ico')).toBe(false);
    expect(ATTACHMENT_ALLOWED_EXTENSIONS.has('.bmp')).toBe(false);
  });

  it('all extensions in the set are also present in EXTENSION_MIME_MAP', () => {
    for (const ext of ATTACHMENT_ALLOWED_EXTENSIONS) {
      expect(EXTENSION_MIME_MAP).toHaveProperty(ext);
    }
  });
});

describe('detectImageFormat', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const GIF87 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]);
  const GIF89 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);

  it('detects PNG', () => {
    expect(detectImageFormat(PNG)).toEqual({ format: 'png', ext: '.png', mime: 'image/png' });
  });

  it('detects JPEG', () => {
    expect(detectImageFormat(JPEG)).toEqual({ format: 'jpeg', ext: '.jpg', mime: 'image/jpeg' });
  });

  it('detects WebP', () => {
    expect(detectImageFormat(WEBP)).toEqual({ format: 'webp', ext: '.webp', mime: 'image/webp' });
  });

  it('detects both GIF variants', () => {
    expect(detectImageFormat(GIF87)?.format).toBe('gif');
    expect(detectImageFormat(GIF89)?.format).toBe('gif');
  });

  it('returns null for non-image bytes', () => {
    expect(detectImageFormat(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for a RIFF container that is not WebP', () => {
    // RIFF header but "AVI " instead of "WEBP" at offset 8.
    const avi = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectImageFormat(avi)).toBeNull();
  });

  it('returns null for a truncated/too-short buffer', () => {
    expect(detectImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('returns null for a non-Buffer input', () => {
    expect(detectImageFormat('AAAA')).toBeNull();
    expect(detectImageFormat(null)).toBeNull();
  });
});
