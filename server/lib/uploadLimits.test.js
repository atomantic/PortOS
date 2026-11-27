import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  JSON_BODY_LIMIT,
  JSON_BODY_LIMIT_BYTES,
  MAX_BASE64_UPLOAD_BYTES,
  MAX_SCREENSHOT_BYTES,
} from './uploadLimits.js';
import { ATTACHMENT_ALLOWED_EXTENSIONS, detectImageFormat } from './mimeTypes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

describe('uploadLimits', () => {
  it('keeps JSON_BODY_LIMIT and its byte form in agreement', () => {
    const mb = Number(JSON_BODY_LIMIT.replace(/mb$/i, ''));
    expect(Number.isFinite(mb)).toBe(true);
    expect(JSON_BODY_LIMIT_BYTES).toBe(mb * 1024 * 1024);
  });

  it('derives a file cap that actually fits the body limit once base64-encoded', () => {
    // The whole point of the constant: base64 inflates by 4/3, so a raw file at
    // the cap must still encode to less than the body limit. A cap that fails
    // this is the opaque-413 bug it exists to prevent.
    const encoded = Math.ceil(MAX_BASE64_UPLOAD_BYTES / 3) * 4;
    expect(encoded).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    // …and it should not be needlessly conservative: one more MB must overflow.
    const oneMbMore = Math.ceil((MAX_BASE64_UPLOAD_BYTES + 1024 * 1024) / 3) * 4;
    expect(oneMbMore).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
  });

  it('is a whole number of MB so the advertised limit reads cleanly', () => {
    expect(MAX_BASE64_UPLOAD_BYTES % (1024 * 1024)).toBe(0);
  });

  it('caps screenshots below the wire limit', () => {
    expect(MAX_SCREENSHOT_BYTES).toBeLessThan(MAX_BASE64_UPLOAD_BYTES);
  });

  it('is the only place the express body limit is written', () => {
    // server/index.js must consume JSON_BODY_LIMIT rather than re-hardcode it —
    // otherwise raising the limit here silently leaves the parser behind.
    const indexSrc = read('../index.js');
    expect(indexSrc).toContain('JSON_BODY_LIMIT');
    expect(indexSrc).not.toMatch(/express\.(json|urlencoded)\(\{\s*limit:\s*['"]/);
  });

  it('keeps the client attachment-extension list in lockstep with the server', () => {
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/export const ALLOWED_ATTACHMENT_EXTENSIONS = \[([\s\S]*?)\];/);
    expect(match, 'client ALLOWED_ATTACHMENT_EXTENSIONS not found').toBeTruthy();
    const clientExts = [...match[1].matchAll(/'(\.[a-z0-9]+)'/g)].map((m) => m[1]);
    expect(new Set(clientExts)).toEqual(ATTACHMENT_ALLOWED_EXTENSIONS);
  });

  it('matches the client mirror, which cannot import this module', () => {
    // client/src/utils/fileUpload.js hardcodes the same number to size-check
    // before uploading. If it drifts high, the user picks a file the parser
    // then rejects with no message — the bug this constant exists to kill.
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/JSON_UPLOAD_MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/);
    expect(match, 'client mirror not found — did JSON_UPLOAD_MAX_FILE_SIZE move?').toBeTruthy();
    expect(Number(match[1]) * 1024 * 1024).toBe(MAX_BASE64_UPLOAD_BYTES);
  });

  it('is the only place per-route upload caps are written', () => {
    // A route that re-derives its own byte cap is how uploads.js and
    // attachments.js drifted to unreachable 100MB/50MB claims. Discover the
    // routes rather than listing them, so a NEW upload route added later is
    // covered too — a hardcoded list would leave it unguarded.
    // Detect the base64-in-JSON transport specifically — decoding a base64 body,
    // or handing one to a shared saver. Routes that take RAW bytes via
    // express.raw() (imageClean.js) carry their own limit and are correctly out
    // of scope: no ×4/3 inflation applies to them.
    //
    // A route may also DELEGATE: `routes/shell.js` validates the body and hands it
    // to `services/shellImageDrop.js`, which calls the saver and owns the cap. So
    // each route is checked together with the services it imports — otherwise
    // moving the decode one file down silently exits this guard. Only the shared
    // savers count as a delegation signal, not a bare base64 decode: plenty of
    // services (mbox import, message sync) decode base64 that never came from a
    // client upload and have no business carrying an upload cap.
    const routesDir = join(HERE, '../routes');
    const SAVERS = /saveBase64Upload|saveImageUpload/;
    const INLINE_DECODE = /Buffer\.from\([^)]*'base64'\)/;
    const SHARED_CAP_IMPORT = /import\s*\{[^}]*\b(?:MAX_BASE64_UPLOAD_BYTES|MAX_SCREENSHOT_BYTES)\b[^}]*\}\s*from '\.[^']*\/uploadLimits\.js'/;
    const readSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

    const routeFiles = readdirSync(routesDir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

    const uploadRoutes = routeFiles.map((f) => {
      const src = readFileSync(join(routesDir, f), 'utf8');
      // The route's own service imports, read so a delegated saver is visible.
      const delegates = [...src.matchAll(/from '\.\.\/services\/([\w/.-]+\.js)'/g)]
        .map((m) => ({ name: `services/${m[1]}`, src: readSafe(join(HERE, '../services', m[1])) }))
        .filter((s) => SAVERS.test(s.src));
      // A domain validation module can own the cap before the saver runs.
      const validators = [...src.matchAll(/from '\.\.\/lib\/([\w/.-]*Validation\.js)'/g)]
        .map((m) => ({ name: `lib/${m[1]}`, src: readSafe(join(HERE, m[1])) }));
      return { name: f, src, delegates, validators };
    }).filter((r) => INLINE_DECODE.test(r.src) || SAVERS.test(r.src) || r.delegates.length > 0);

    expect(uploadRoutes.length, 'no upload routes discovered — did the detection heuristic break?')
      .toBeGreaterThanOrEqual(5);

    for (const route of uploadRoutes) {
      // The route, its validator, or its delegated saver must import a shared
      // cap. A check for only one literal spelling would miss other ways of
      // hardcoding the same number.
      const chain = [{ name: route.name, src: route.src }, ...route.delegates, ...route.validators];
      const where = chain.map((f) => f.name).join(' / ');
      expect(chain.some((f) => SHARED_CAP_IMPORT.test(f.src)),
        `${where} must take its cap from lib/uploadLimits.js`).toBe(true);
      // Belt-and-braces: no raw MB-shaped byte literal left anywhere on the path.
      for (const file of chain) {
        expect(file.src, `${file.name} still hardcodes a raw byte cap`)
          .not.toMatch(/=\s*\d+\s*\*\s*1024\s*\*\s*1024/);
      }
    }
  });

  it('matches the client mirror of the supported image formats', () => {
    // The client refuses an unsupported image at pick time — a drag-drop or a
    // clipboard paste bypasses the picker's `accept`, so without a client-side
    // check an AVIF/SVG only fails after the user typed their message. That list
    // mirrors `detectImageFormat` here, which the client can't import; if the
    // server learns a new format and the mirror doesn't, the client rejects
    // something the server would happily accept.
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/SUPPORTED_UPLOAD_IMAGE_MIME = \[([^\]]*)\]/);
    expect(match, 'client mirror not found — did SUPPORTED_UPLOAD_IMAGE_MIME move?').toBeTruthy();
    const mirrored = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    // Derive the server's set from detectImageFormat itself rather than restating
    // it, so this compares behavior and not two copies of a literal.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]);
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    const supported = [png, jpeg, gif, webp].map((b) => detectImageFormat(b)?.mime);
    expect(supported, 'a probe stopped matching detectImageFormat').not.toContain(undefined);

    expect(mirrored).toEqual([...new Set(supported)].sort());
  });

  it('matches the client mirror of the screenshot cap', () => {
    // Screenshots have their own (smaller, product-chosen) cap. It is mirrored
    // client-side too, so it needs the same drift guard as the wire limit —
    // otherwise raising one side silently leaves the other rejecting.
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/SCREENSHOT_MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/);
    expect(match, 'client screenshot mirror not found — did SCREENSHOT_MAX_FILE_SIZE move?').toBeTruthy();
    expect(Number(match[1]) * 1024 * 1024).toBe(MAX_SCREENSHOT_BYTES);
  });
});
