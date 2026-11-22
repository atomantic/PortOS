import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, truncate, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractDeliverablePaths,
  stripDeliverablePaths,
  firstImagePath,
  classifyAttachment,
  resolveDeliverable,
  collectNotificationDeliverables,
  TELEGRAM_MAX_UPLOAD_BYTES,
  TELEGRAM_MAX_PHOTO_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_RESOLVE_ATTEMPTS
} from './telegramDeliverables.js';

describe('extractDeliverablePaths', () => {
  it('finds absolute, /data/ URL and data/-relative artifact paths in prose', () => {
    const text = 'Rendered /tmp/example/out.png and see /data/images/abc.png plus data/cos/reports/r.pdf.';
    expect(extractDeliverablePaths(text)).toEqual(['/tmp/example/out.png', '/data/images/abc.png', 'data/cos/reports/r.pdf']);
  });

  it('never extracts paths inside fenced code blocks or inline backticks', () => {
    const text = [
      'Inline `/data/images/inline.png` stays.',
      '```',
      '/data/images/fenced.png',
      '```',
      'Unterminated ```',
      '/data/images/open.png'
    ].join('\n');
    expect(extractDeliverablePaths(text)).toEqual([]);
  });

  it('pulls the target out of a markdown image and ignores disallowed extensions', () => {
    expect(extractDeliverablePaths('![daily](/data/images/d.png) and /data/settings.json and /x/.env')).toEqual(['/data/images/d.png']);
  });

  it('never mines a local path out of an http(s) URL or mid-token', () => {
    expect(extractDeliverablePaths('see https://example.com/files/x.png and host/data/images/y.png or /data/images/z.png')).toEqual(['/data/images/z.png']);
  });

  it('handles empty and non-string input', () => {
    expect(extractDeliverablePaths('')).toEqual([]);
    expect(extractDeliverablePaths(undefined)).toEqual([]);
  });
});

describe('firstImagePath', () => {
  it('returns the first prose image path, skipping code and non-images', () => {
    expect(firstImagePath('`/data/images/a.png` /data/cos/reports/r.pdf /data/images/b.webp /data/images/c.png')).toBe('/data/images/b.webp');
    expect(firstImagePath('no images')).toBeNull();
    expect(firstImagePath(undefined)).toBeNull();
  });
});

describe('stripDeliverablePaths', () => {
  it('removes delivered paths (and wrapping markdown) from prose but leaves code untouched', () => {
    const text = 'Image: ![d](/data/images/d.png)\nAlso /data/images/d.png here\n`/data/images/d.png`';
    expect(stripDeliverablePaths(text, ['/data/images/d.png'])).toBe('Image:\nAlso  here\n`/data/images/d.png`');
  });

  it('is a no-op when nothing was delivered', () => {
    expect(stripDeliverablePaths('keep /data/images/x.png ', [])).toBe('keep /data/images/x.png ');
  });
});

describe('classifyAttachment', () => {
  it('routes by extension lane, using only formats each Bot API method accepts', () => {
    expect(classifyAttachment('/a/x.PNG')).toEqual({ method: 'sendPhoto', field: 'photo' });
    expect(classifyAttachment('/a/x.gif')).toEqual({ method: 'sendAnimation', field: 'animation' });
    expect(classifyAttachment('/a/x.mp3')).toEqual({ method: 'sendAudio', field: 'audio' });
    expect(classifyAttachment('/a/x.m4a').method).toBe('sendAudio');
    expect(classifyAttachment('/a/x.mp4')).toEqual({ method: 'sendVideo', field: 'video' });
    expect(classifyAttachment('/a/x.pdf')).toEqual({ method: 'sendDocument', field: 'document' });
    for (const name of ['x.wav', 'x.flac', 'x.ogg', 'x.opus', 'x.mov', 'x.webm']) {
      expect(classifyAttachment(`/a/${name}`).method, name).toBe('sendDocument');
    }
  });

  it('sends images as documents for asDocument, kind:document, or over the photo limit', () => {
    expect(classifyAttachment('/a/x.png', { asDocument: true }).method).toBe('sendDocument');
    expect(classifyAttachment('/a/x.jpg', { kind: 'document' }).method).toBe('sendDocument');
    expect(classifyAttachment('/a/x.jpg', { size: TELEGRAM_MAX_PHOTO_BYTES + 1 }).method).toBe('sendDocument');
  });

  it('promotes only .ogg/.opus to a voice bubble', () => {
    expect(classifyAttachment('/a/x.ogg', { audioAsVoice: true })).toEqual({ method: 'sendVoice', field: 'voice' });
    expect(classifyAttachment('/a/x.opus', { kind: 'voice' }).method).toBe('sendVoice');
    expect(classifyAttachment('/a/x.mp3', { audioAsVoice: true }).method).toBe('sendAudio');
  });

  it('refuses source, config and secret extensions', () => {
    for (const name of ['.env', 'x.js', 'x.json', 'x.key', 'x.pem', 'x.sqlite']) {
      expect(classifyAttachment(`/a/${name}`)).toBeNull();
    }
  });
});

describe('resolveDeliverable / collectNotificationDeliverables (filesystem jail)', () => {
  let base;
  let dataRoot;
  let images;
  let reports;
  let opts;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'tg-deliverables-')));
    dataRoot = join(base, 'data');
    images = join(dataRoot, 'images');
    reports = join(dataRoot, 'cos', 'reports');
    await mkdir(images, { recursive: true });
    await mkdir(reports, { recursive: true });
    await mkdir(join(base, 'outside'), { recursive: true });
    await writeFile(join(images, 'daily.png'), 'png-bytes');
    await writeFile(join(images, 'clip.ogg'), 'ogg-bytes');
    await writeFile(join(images, 'empty.png'), '');
    await writeFile(join(reports, 'report.pdf'), 'pdf-bytes');
    await writeFile(join(dataRoot, 'settings.json'), '{"secret":true}');
    await writeFile(join(dataRoot, 'loose.png'), 'not in a root');
    await writeFile(join(base, 'outside', 'escape.png'), 'outside bytes');
    await writeFile(join(images, 'big.zip'), '');
    await truncate(join(images, 'big.zip'), TELEGRAM_MAX_UPLOAD_BYTES + 1);
    // Symlink escapes: an image-named link out of the jail, and to a secret.
    await symlink(join(base, 'outside', 'escape.png'), join(images, 'link-out.png'));
    await symlink(join(dataRoot, 'settings.json'), join(images, 'link-secret.png'));
    opts = { roots: [images, reports], dataRoot };
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('accepts an absolute path inside an artifact root', async () => {
    const result = await resolveDeliverable({ path: join(images, 'daily.png'), caption: '  Daily  ' }, opts);
    expect(result).toEqual({
      ok: true,
      attachment: { path: join(images, 'daily.png'), filename: 'daily.png', method: 'sendPhoto', field: 'photo', caption: 'Daily', size: 9 }
    });
  });

  it('maps the /data/ URL form onto the data root', async () => {
    const result = await resolveDeliverable({ path: '/data/cos/reports/report.pdf' }, opts);
    expect(result.ok).toBe(true);
    expect(result.attachment.method).toBe('sendDocument');
  });

  it('refuses paths outside the roots, traversal, symlink escapes and secret extensions', async () => {
    const refused = [
      [join(dataRoot, 'loose.png'), 'outside artifact directories'],
      [join(images, '..', '..', 'outside', 'escape.png'), 'outside artifact directories'],
      [join(images, 'link-out.png'), 'outside artifact directories'],
      [join(images, 'link-secret.png'), 'resolved extension not allowed'],
      [join(dataRoot, 'settings.json'), 'extension not allowed'],
      ['relative/x.png', 'not an absolute artifact path'],
      ['~/x.png', 'not an absolute artifact path'],
      [images, 'extension not allowed']
    ];
    for (const [path, reason] of refused) {
      expect(await resolveDeliverable({ path }, opts), path).toEqual({ ok: false, reason });
    }
  });

  it('skips missing, empty and oversize files', async () => {
    expect(await resolveDeliverable({ path: join(images, 'gone.png') }, opts)).toEqual({ ok: false, reason: 'missing file' });
    expect(await resolveDeliverable({ path: join(images, 'empty.png') }, opts)).toEqual({ ok: false, reason: 'empty file' });
    expect((await resolveDeliverable({ path: join(images, 'big.zip') }, opts)).reason).toMatch(/exceeds 50 MB/);
  });

  it('collects structured attachments and text paths with the prose tokens that located them, and fails open', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await collectNotificationDeliverables({
      description: `Today: /data/images/daily.png\nMissing: /data/images/gone.png\nCode: \`/data/images/clip.ogg\``,
      metadata: {
        audioAsVoice: true,
        attachments: [{ path: join(images, 'clip.ogg') }, { path: join(images, 'daily.png') }, { nope: true }]
      }
    }, opts);
    log.mockRestore();

    expect(result.map(a => [a.filename, a.method, a.rawTokens])).toEqual([
      ['clip.ogg', 'sendVoice', []],
      ['daily.png', 'sendPhoto', ['/data/images/daily.png']]
    ]);
  });

  it('applies metadata.asDocument to every attachment', async () => {
    const result = await collectNotificationDeliverables({ description: '', metadata: { asDocument: true, attachments: [{ path: join(images, 'daily.png') }] } }, opts);
    expect(result[0].method).toBe('sendDocument');
  });

  it('caps the attachments per notification', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 3 }, (_, i) => ({ path: join(images, `n${i}.png`) }));
    await Promise.all(many.map(({ path }) => writeFile(path, 'x')));
    const result = await collectNotificationDeliverables({ metadata: { attachments: many } }, opts);
    log.mockRestore();
    expect(result).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  it('still credits a prose token to an already-accepted file once the upload cap is hit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) => ({ path: join(images, `n${i}.png`) }));
    await Promise.all(many.map(({ path }) => writeFile(path, 'x')));
    const result = await collectNotificationDeliverables({ description: 'again /data/images/n0.png', metadata: { attachments: many } }, opts);
    log.mockRestore();
    expect(result).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result[0].rawTokens).toEqual(['/data/images/n0.png']);
  });

  it('bounds resolve attempts, refusals included', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const refused = Array.from({ length: MAX_RESOLVE_ATTEMPTS }, (_, i) => ({ path: join(images, `missing${i}.png`) }));
    const result = await collectNotificationDeliverables({ metadata: { attachments: [...refused, { path: join(images, 'daily.png') }] } }, opts);
    log.mockRestore();
    expect(result).toEqual([]);
  });
});
