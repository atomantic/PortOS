/** Data-only portable project boundary. Validation never reads or executes files. */
import { createHash } from 'crypto';
import { z } from 'zod';
import { canonicalStringify } from './objects.js';
import { EFFORT_LEVELS } from './providerModels.js';

export const CODE_ANIMATION_PACKAGE_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathLength: 240,
});

const L = CODE_ANIMATION_PACKAGE_LIMITS;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a SHA-256 digest');
// Portable paths have one spelling on Windows and POSIX. No escaping/decoding
// is performed by the package contract, and hidden/config paths are excluded.
const pathSchema = z.string().min(1).max(L.pathLength).refine((value) =>
  value.split('/').every((part) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/i.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
'Expected a portable relative package path');
const text = (max) => z.string().max(max);
const settingsSchema = z.object({
  harness: text(128).nullable(),
  connection: text(128).nullable(),
  mode: z.enum(['api', 'cli', 'tui']).nullable(),
  model: text(256).nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
}).strict();

export const codeAnimationManifestSchema = z.object({
  title: text(200),
  brief: z.object({ concept: text(6000), cast: text(4000), onScreenText: text(4000) }).strict(),
  styleGuide: text(16000),
  renderer: z.object({
    kind: z.enum(['browser', 'blender']),
    version: z.string().min(1).max(128),
    engine: text(128).nullable(),
  }).strict(),
  format: z.object({
    width: z.number().int().min(2).max(8192).multipleOf(2),
    height: z.number().int().min(2).max(8192).multipleOf(2),
    fps: z.number().int().min(1).max(60),
    durationSeconds: z.number().positive().max(180),
  }).strict(),
  seed: z.number().int().min(0).max(0xffffffff).nullable(),
  entrypoints: z.array(z.object({
    role: z.enum(['scene', 'preview', 'render']), path: pathSchema,
  }).strict()).min(1).max(3),
  assets: z.array(pathSchema).max(L.files),
  shots: z.array(z.object({
    label: text(200), startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
  }).strict()).max(128),
  events: z.array(z.object({ label: text(200), atSeconds: z.number().nonnegative() }).strict()).max(512),
  audio: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('silence') }).strict(),
    z.object({ kind: z.literal('procedural'), notes: text(1500) }).strict(),
    // External audio is a declaration only: it contains no install-local URL/id.
    z.object({ kind: z.literal('external'), notes: text(1500) }).strict(),
    z.object({ kind: z.literal('file'), path: pathSchema }).strict(),
  ]),
  execution: z.object({ requested: settingsSchema.nullable(), effective: settingsSchema.nullable() }).strict(),
}).strict();

const fileSchema = z.object({
  path: pathSchema,
  encoding: z.enum(['utf8', 'base64']),
  content: z.string().max(4 * Math.ceil(L.fileBytes / 3)),
  sha256: hashSchema,
}).strict();

// Hash decoded bytes through file digests, not base64/UTF-8 transport spelling.
// File order is incidental; shot/event/entrypoint order remains semantic.
const revisionHashOf = ({ schemaVersion, manifest, files }) => digest(canonicalStringify({
  schemaVersion,
  manifest,
  files: files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
}));

const shapeSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: codeAnimationManifestSchema,
  files: z.array(fileSchema).min(1).max(L.files),
  revisionHash: hashSchema,
}).strict();

export const codeAnimationPackageSchema = shapeSchema.superRefine((pkg, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
  const paths = new Set();
  const folded = new Set();
  let totalBytes = 0;
  for (const [index, file] of pkg.files.entries()) {
    const lower = file.path.toLowerCase();
    if (folded.has(lower)) issue(['files', index, 'path'], 'Duplicate or case-colliding file path');
    folded.add(lower);
    paths.add(file.path);
    // Bound allocation before decoding, even when a child string is already invalid.
    if (file.content.length > 4 * Math.ceil(L.fileBytes / 3)) continue;
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.toString(file.encoding === 'base64' ? 'base64' : 'utf8') !== file.content) {
      issue(['files', index, 'content'], 'Noncanonical base64 or invalid UTF-8 text');
    }
    totalBytes += bytes.length;
    if (bytes.length > L.fileBytes) issue(['files', index, 'content'], 'File exceeds the decoded byte limit');
    if (digest(bytes) !== file.sha256) issue(['files', index, 'sha256'], 'File digest does not match its bytes');
  }
  if (totalBytes > L.totalBytes) issue(['files'], 'Package exceeds the decoded byte limit');
  for (const [index, file] of pkg.files.entries()) {
    const parts = file.path.toLowerCase().split('/');
    if (parts.slice(0, -1).some((_, i) => folded.has(parts.slice(0, i + 1).join('/')))) {
      issue(['files', index, 'path'], 'File path collides with a parent file');
    }
  }
  const roles = new Set();
  for (const [index, entry] of pkg.manifest.entrypoints.entries()) {
    if (roles.has(entry.role)) issue(['manifest', 'entrypoints', index, 'role'], 'Duplicate entrypoint role');
    roles.add(entry.role);
    if (!paths.has(entry.path)) issue(['manifest', 'entrypoints', index, 'path'], 'Entrypoint file is missing');
  }
  for (const [index, path] of pkg.manifest.assets.entries()) {
    if (!paths.has(path)) issue(['manifest', 'assets', index], 'Asset file is missing');
  }
  if (pkg.manifest.audio.kind === 'file' && !paths.has(pkg.manifest.audio.path)) {
    issue(['manifest', 'audio', 'path'], 'Audio file is missing');
  }
  const duration = pkg.manifest.format.durationSeconds;
  for (const [index, shot] of pkg.manifest.shots.entries()) {
    if (shot.endSeconds <= shot.startSeconds || shot.endSeconds > duration) {
      issue(['manifest', 'shots', index], 'Shot must have positive length within the film');
    }
  }
  for (const [index, event] of pkg.manifest.events.entries()) {
    if (event.atSeconds > duration) issue(['manifest', 'events', index], 'Event lies outside the film');
  }
  if (revisionHashOf(pkg) !== pkg.revisionHash) issue(['revisionHash'], 'Revision digest does not match the package');
});

/** Build a package from explicit metadata and text/binary file bytes. */
export function createCodeAnimationPackage(manifest, files) {
  const payload = {
    schemaVersion: 1,
    manifest,
    files: files.map(({ path, content, encoding = 'utf8' }) => ({
      path, content, encoding, sha256: digest(Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')),
    })),
  };
  return codeAnimationPackageSchema.parse({ ...payload, revisionHash: revisionHashOf(payload) });
}

/** Integrity is a data check, never a verdict on code safety or render quality. */
export function summarizeCodeAnimationPackage(pkg) {
  return {
    schemaVersion: pkg.schemaVersion,
    revisionHash: pkg.revisionHash,
    renderer: pkg.manifest.renderer,
    fileCount: pkg.files.length,
    totalBytes: pkg.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), 0),
    executed: false,
  };
}
