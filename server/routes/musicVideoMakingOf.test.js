import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { mkdir, writeFile, symlink, link as hardLinkFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const { records, jobs } = vi.hoisted(() => ({ records: new Map(), jobs: new Map() }));
vi.mock('../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-making-of-') }));
vi.mock('../services/musicVideo/projects.js', async importOriginal => ({ ...await importOriginal(), getProject: vi.fn(async id => records.get(id) || null) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ getJob: id => jobs.get(id) }));
import musicVideoRoutes from './musicVideo.js';
import { compileMakingOf, getMakingOfCatalog } from '../services/musicVideo/makingOf.js';
import { renderCastAndSetsSheet } from '../services/musicVideo/castAndSetsSheet.js';

const root = () => lazyTempDataRoot('portos-making-of-');
const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);
afterAll(cleanupTempDataRoots);

async function file(relative, data) {
  const path = join(root(), relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, data);
}
const artifact = (id, ext = 'html', source = 'generated') => ({ id, kind: 'cast-sets', title: 'Example guide', version: 1, status: 'pending',
  versions: [{ version: 1, source, file: `music-video/mv-example/dev/${id}/v1.${ext}` }] });
function fixture(extra = {}) {
  return { id: 'mv-example', name: 'Example Blueprint', version: 1, mediaMode: 'code-only', updatedAt: '2026-01-01T00:00:00Z',
    concept: { prompt: 'Example story' }, audioAnalysis: { durationSec: 120 },
    scenes: [{ sceneId: 'scene-example', label: '=unsafe formula', startSec: 0, endSec: 12, visualIntent: 'Open at the fictional harbor', framePrompt: 'A room', takes: [] }],
    lyricCues: [{ id: 'cue-example', text: 'Example lyric', startSec: 0, endSec: 5, words: [{ w: 'Example', startSec: 0, endSec: 1 }] }],
    productionReview: { draft: { cast: 'A keeper', environments: 'Harbor', storyboard: [{ id: 'shot-example', sceneId: 'scene-example', startSec: 0, endSec: 12, lyricCueIds: ['cue-example'], action: 'Light the lamp', staging: 'Doorway', camera: 'Dolly', transition: 'Hold' }] } },
    devArtifacts: [], ...extra };
}
async function select(ids = []) {
  const catalog = await request(app).get('/api/music-video/mv-example/making-of/catalog');
  expect(catalog.status).toBe(200);
  return { projects: [{ projectId: 'mv-example', snapshot: catalog.body.snapshot, assets: ids.map(id => ({ id, rights: 'unknown', attribution: '' })) }] };
}
async function preview(selection) {
  const result = await request(app).post('/api/music-video/making-of/preview').send(selection);
  expect(result.status).toBe(200);
  return result.body;
}
// Stored ZIP members: inspect the actual deliverable bytes, not only its echo.
function members(zip) {
  const entries = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}
beforeEach(() => { records.clear(); jobs.clear(); records.set('mv-example', fixture()); });

describe('local making-of compilation', () => {
  it('keeps multiline entity-encoded image captions inert in exported Markdown', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#227766' } }).png().toBuffer();
    const sheet = artifact('caption-example');
    records.get('mv-example').devArtifacts = [sheet];
    await file(sheet.versions[0].file, `<img src="data:image/png;base64,${png.toString('base64')}" alt="Harbor [plate]\\\n\r\n&lt;script&gt;active()&lt;/script&gt;\n&lt;img src=evil onerror=active()&gt;">`);
    const selection = await select(['artifact:caption-example:v1']);
    selection.projects[0].assets[0] = { ...selection.projects[0].assets[0], rights: 'owned', ownershipConfirmed: true };
    const result = await preview(selection);
    const out = await compileMakingOf({ ...selection, previewDigest: result.previewDigest }, { download: true });
    const md = members(out.zip).get('projects/mv-example/artifacts/caption-example/v1.md').toString();
    expect(md).not.toMatch(/<script>|<img|\r/);
    expect(md).toContain('&lt;script&gt;active()&lt;/script&gt;');
    const link = md.split('\n').find(line => line.startsWith('!['));
    expect(link).toContain('Harbor \\[plate\\]');
    expect(link).toContain('&lt;img src=evil onerror=active()&gt;');
    expect(link).toMatch(/\]\(v1-visuals\/visual-01-[a-f0-9]+\.png\)$/);
  });

  it('bakes mirrored and rotated JPEG orientation into portable pixels before stripping EXIF', async () => {
    const colors = [[200, 20, 30], [20, 200, 30], [20, 30, 200], [200, 200, 20]];
    const width = 48, height = 32;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
      pixels.set(color, (y * width + x) * 3);
    }
    const orientations = [{ value: 2, corners: [1, 0, 3, 2], width, height },
      { value: 6, corners: [2, 0, 3, 1], width: height, height: width },
      { value: 7, corners: [3, 1, 2, 0], width: height, height: width }];
    const sheet = artifact('orientation-example');
    records.get('mv-example').devArtifacts = [sheet];
    const inputs = await Promise.all(orientations.map(async orientation => {
      const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: orientation.value }).toBuffer();
      expect((await sharp(jpeg).metadata()).orientation).toBe(orientation.value);
      return `<img src="data:image/jpeg;base64,${jpeg.toString('base64')}" alt="Orientation ${orientation.value}">`;
    }));
    await file(sheet.versions[0].file, inputs.join('\n'));
    const selection = await select(['artifact:orientation-example:v1']);
    selection.projects[0].assets[0] = { ...selection.projects[0].assets[0], rights: 'owned', ownershipConfirmed: true };
    const result = await preview(selection);
    const out = await compileMakingOf({ ...selection, previewDigest: result.previewDigest }, { download: true });
    const files = members(out.zip);
    const visuals = out.manifest.inventory.filter(item => item.id.startsWith('artifact:orientation-example:v1:visual:'));
    expect(visuals).toHaveLength(orientations.length);
    for (let index = 0; index < visuals.length; index += 1) {
      const image = files.get(visuals[index].path);
      const metadata = await sharp(image).metadata();
      const expected = orientations[index];
      expect(metadata).toMatchObject({ width: expected.width, height: expected.height, format: 'png' });
      expect(metadata.orientation).toBeUndefined(); expect(metadata.exif).toBeUndefined();
      const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const positions = [[4, 4], [info.width - 5, 4], [4, info.height - 5], [info.width - 5, info.height - 5]];
      positions.forEach(([x, y], corner) => colors[expected.corners[corner]].forEach((channel, component) => {
        expect(Math.abs(data[(y * info.width + x) * info.channels + component] - channel)).toBeLessThan(10);
      }));
    }
  });

  it('marks unsupported CSS graphics and stylesheet dependencies partial without loading them', async () => {
    const sheet = artifact('css-resource-example');
    records.get('mv-example').devArtifacts = [sheet];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Export must not fetch CSS'); });
    try {
      await file(sheet.versions[0].file, `<style>.panel{background-image:url(https://example.com/private-reference.png)}</style>
        <div style="background:url(data:image/png;base64,AAAA)">Panel caption</div>
        <section style="back\\67round-image:linear-gradient(red,blue)">Gradient caption</section>
        <link rel="stylesheet" href="https://example.com/private-style.css"><p>Story notes</p>
        <style>.plain{background-image: none; background:#123;}</style>`);
      // Use the service boundary while spying: the route-test client itself uses fetch.
      const catalog = await getMakingOfCatalog('mv-example');
      const selection = { projects: [{ projectId: 'mv-example', snapshot: catalog.snapshot, assets: [{ id: 'artifact:css-resource-example:v1', rights: 'unknown' }] }] };
      expect(catalog.assets[0]).toMatchObject({ status: 'partial', visualCount: 4 });
      const result = await compileMakingOf(selection);
      expect(result.manifest.inventory.find(item => item.id === 'artifact:css-resource-example:v1')).toMatchObject({ status: 'partial', reason: 'some-visuals-not-exported' });
      const omitted = result.manifest.inventory.filter(item => item.id.startsWith('artifact:css-resource-example:v1:visual:'));
      expect(omitted).toHaveLength(4);
      expect(omitted.every(item => item.status === 'excluded' && item.reason === 'css-visual-not-exported' && item.path === null)).toBe(true);
      const out = await compileMakingOf({ ...selection, previewDigest: result.previewDigest }, { download: true });
      const md = members(out.zip).get('projects/mv-example/artifacts/css-resource-example/v1.md').toString();
      expect(md.match(/omitted: css-visual-not-exported/g)).toHaveLength(4);
      expect(md).toContain('Panel caption'); expect(md).toContain('Gradient caption'); expect(md).toContain('Story notes');
      expect(out.zip.toString()).not.toMatch(/https?:\/\/|data:image|<style|<link/);
      await file(sheet.versions[0].file, '<div style="background-image:url(https://example.com/reference.png)"></div>'.repeat(81));
      expect((await getMakingOfCatalog('mv-example')).assets[0]).toMatchObject({ status: 'excluded', reason: 'visual-count-limit' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it('retains native cast/set raster plates and all 26 static storyboard graphics as portable images in source order', async () => {
    const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: '#227766' } }).png().toBuffer();
    const cast = artifact('visual-cast-example');
    const storyboard = artifact('visual-board-example'); storyboard.kind = 'storyboard';
    records.get('mv-example').devArtifacts = [cast, storyboard];
    const castHTML = renderCastAndSetsSheet({ title: 'Example Production',
      direction: { protagonist: { name: 'Example Keeper' }, sets: [{ id: 'harbor', name: 'Harbor', description: 'Lanterns', lighting: 'Warm', sections: [] }], tests: [], looks: [], songMap: [] },
      images: { character: `data:image/png;base64,${png.toString('base64')}`, 'set:harbor': `data:image/png;base64,${png.toString('base64')}` } });
    const boardHTML = `<html><style>body{background:#111}</style><h1>Full storyboard</h1>${Array.from({ length: 26 }, (_, index) => `<figure><h2>Shot ${index + 1}</h2><svg viewBox="0 0 160 90" role="img" aria-label="Shot ${index + 1}"><rect x="0" y="0" width="160" height="90" fill="#17232f"/><circle cx="80" cy="45" r="${index + 2}" fill="#ffbb66"/><text x="8" y="15" font-size="12" fill="#ffffff">S${index + 1}</text></svg><figcaption>Hold at the harbor — ${index + 1}</figcaption></figure>`).join('')}</html>`;
    await file(cast.versions[0].file, castHTML);
    await file(storyboard.versions[0].file, boardHTML);
    const selection = await select(['artifact:visual-cast-example:v1', 'artifact:visual-board-example:v1']);
    // Raster bytes are not inferred to be owned merely because their container was generated.
    const undeclared = await preview(selection);
    expect(undeclared.manifest.inventory.filter(item => item.id.startsWith('artifact:visual-cast-example:v1:visual:')).every(item => item.reason === 'embedded-raster-ownership-unverified')).toBe(true);
    selection.projects[0].assets[0] = { ...selection.projects[0].assets[0], rights: 'owned', attribution: 'Original project art', ownershipConfirmed: true };
    const inventory = await preview(selection);
    const out = await compileMakingOf({ ...selection, previewDigest: inventory.previewDigest }, { download: true });
    const files = members(out.zip);
    const boardVisuals = out.manifest.inventory.filter(item => item.id.startsWith('artifact:visual-board-example:v1:visual:'));
    expect(boardVisuals).toHaveLength(26);
    expect(boardVisuals.every(item => item.status === 'included' && files.has(item.path))).toBe(true);
    const castVisuals = out.manifest.inventory.filter(item => item.id.startsWith('artifact:visual-cast-example:v1:visual:'));
    expect(castVisuals).toHaveLength(2);
    expect(castVisuals.every(item => item.status === 'included' && item.rights === 'owned' && item.provenance.ownership === 'operator-declared')).toBe(true);
    const boardMD = files.get('projects/mv-example/artifacts/visual-board-example/v1.md').toString();
    expect(boardMD.indexOf('Shot 1')).toBeLessThan(boardMD.indexOf('Shot 26'));
    expect(boardMD).toContain('Hold at the harbor — 26');
    expect(boardMD.match(/!\[[^\]]*\]\(v1-visuals\/[^)]+\.png\)/g)).toHaveLength(26);
    expect(files.get('projects/mv-example/storyboard.md').toString()).toContain('artifacts/visual-board-example/v1.md');
    expect(out.zip.toString()).not.toMatch(/<svg|<script|data:image|https?:\/\//);
    for (const visual of [...boardVisuals, ...castVisuals]) {
      const metadata = await sharp(files.get(visual.path)).metadata();
      expect(metadata.format).toBe('png'); expect(metadata.exif).toBeUndefined();
      expect(createHash('sha256').update(files.get(visual.path)).digest('hex')).toBe(visual.sha256);
    }
    expect((await compileMakingOf({ ...selection, previewDigest: inventory.previewDigest }, { download: true })).zip.equals(out.zip)).toBe(true);
  });

  it('preserves actual procedural cast definitions without executing a browser or exporting active SVG', async () => {
    const cast = artifact('procedural-cast-example');
    records.get('mv-example').devArtifacts = [cast];
    const direction = { medium: 'procedural', protagonist: { name: 'Example boat' }, sets: [],
      definitions: { characters: [{ id: 'boat', name: 'Paper boat', renderer: 'svg', palette: [{ name: 'cream', hex: '#f5f0e6' }],
        parts: [{ id: 'hull', shape: 'rect', x: 40, y: 100, width: 120, height: 40, fill: 'cream' }],
        expressions: [{ name: 'proud', overrides: { hull: { rotate: -5 } } }], poses: [], motion: [] }] } };
    await file(cast.versions[0].file, renderCastAndSetsSheet({ title: 'Example Blueprint', direction }));
    const selection = await select(['artifact:procedural-cast-example:v1']);
    const result = await preview(selection);
    expect(result.manifest.inventory.filter(item => item.id.startsWith('artifact:procedural-cast-example:v1:visual:'))).toEqual([
      expect.objectContaining({ status: 'included', provenance: expect.objectContaining({ ownership: 'project-generated' }) }),
      expect.objectContaining({ status: 'included', provenance: expect.objectContaining({ ownership: 'project-generated' }) }),
    ]);
  });

  it('rejects active, remote, entity-bearing and unsafe SVG graphics with per-item errors and bounded decoded bytes', async () => {
    const sheet = artifact('unsafe-visual-example');
    records.get('mv-example').devArtifacts = [sheet];
    const svg = body => `<svg viewBox="0 0 16 9">${body}</svg>`;
    await file(sheet.versions[0].file, `<h1>Unapproved resources</h1>${svg('<image href="file:///private-source"/>')}${svg('<rect width="16" height="9" fill="url(https://example.com/reference.png)"/>')}${svg('<text>&external;</text>')}<img src="https://example.com/reference.png"><script>fetch('https://example.com/private')</script><canvas>Needs active rendering</canvas>&lt;script&gt;escapedActiveText()&lt;/script&gt;`);
    const selected = await select(['artifact:unsafe-visual-example:v1']);
    selected.projects[0].assets[0] = { ...selected.projects[0].assets[0], rights: 'owned', ownershipConfirmed: true };
    const result = await preview(selected);
    const errors = result.manifest.inventory.filter(item => item.id.startsWith('artifact:unsafe-visual-example:v1:visual:'));
    expect(errors).toHaveLength(6);
    expect(errors.every(item => item.status === 'excluded' && item.path === null)).toBe(true);
    expect(errors.map(item => item.reason)).toEqual(['unsafe-or-invalid-svg', 'unsafe-or-invalid-svg', 'unsafe-or-invalid-svg', 'remote-visual-not-exported', 'active-visual-not-exported', 'active-visual-not-exported']);
    expect(result.manifest.inventory.find(item => item.id === 'artifact:unsafe-visual-example:v1').status).toBe('partial');
    const out = await compileMakingOf({ ...selected, previewDigest: result.previewDigest }, { download: true });
    expect(out.zip.toString()).not.toMatch(/<svg|<script|https?:\/\/|\/private-source/);
    await file(sheet.versions[0].file, '<img src="data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') + '">');
    expect((await preview(selected)).manifest.inventory.find(item => item.id.endsWith(':visual:1')).reason).toBe('visual-size-limit');
    await file(sheet.versions[0].file, Array.from({ length: 81 }, () => svg('<rect width="16" height="9" fill="#ffffff"/>')).join(''));
    expect((await preview(selected)).manifest.inventory.find(item => item.id === 'artifact:unsafe-visual-example:v1')).toMatchObject({ status: 'excluded', reason: 'visual-count-limit' });
  });

  it('admits selected shared references and cloned artifacts only through a selected owning project or an explicit owned declaration', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer();
    const sourceArtifact = artifact('shared-guide-example');
    const owner = records.get('mv-example');
    owner.devArtifacts = [sourceArtifact];
    owner.castAndSets = { plan: { 'set:harbor': { label: 'Harbor' } }, images: { 'set:harbor': { imageId: 'shared-owned.png', jobId: 'shared-job' } } };
    jobs.set('shared-job', { kind: 'image', params: { musicVideo: { projectId: owner.id, castAndSets: { key: 'set:harbor' } } }, result: { filename: 'shared-owned.png' } });
    await file('images/shared-owned.png', png); await file(sourceArtifact.versions[0].file, '<h1>Shared original guide</h1>');
    const hybrid = fixture({ id: 'mv-shared-hybrid', name: 'Example Shared Hybrid', devArtifacts: [sourceArtifact],
      visualSpec: { references: [{ id: 'shared-reference', imageId: 'shared-owned.png', label: 'Shared owned set' }] } });
    records.set(hybrid.id, hybrid);
    const hybridCatalog = await request(app).get(`/api/music-video/${hybrid.id}/making-of/catalog`);
    const selection = { projects: [{ projectId: hybrid.id, snapshot: hybridCatalog.body.snapshot, assets: [{ id: 'reference:shared-reference', rights: 'unknown' }, { id: 'artifact:shared-guide-example:v1', rights: 'unknown' }] }] };
    const alone = await preview(selection);
    expect(alone.manifest.inventory.find(item => item.id === 'reference:shared-reference').reason).toBe('ownership-unverified');
    expect(alone.manifest.inventory.find(item => item.id === 'artifact:shared-guide-example:v1').reason).toBe('owner-project-not-selected');
    const ownerCatalog = await request(app).get(`/api/music-video/${owner.id}/making-of/catalog`);
    selection.projects.push({ projectId: owner.id, snapshot: ownerCatalog.body.snapshot, assets: [] });
    const verified = await preview(selection);
    expect(verified.manifest.inventory.find(item => item.projectId === hybrid.id && item.id === 'reference:shared-reference')).toMatchObject({ status: 'included', delivery: 'file', provenance: expect.objectContaining({ sourceProjectId: owner.id, ownership: 'project-generated' }) });
    expect(verified.manifest.inventory.find(item => item.projectId === hybrid.id && item.id === 'artifact:shared-guide-example:v1').status).toBe('included');
    expect(verified.manifest.inventory.find(item => item.projectId === owner.id && item.id === 'cast:set:harbor').status).toBe('not-selected');
    jobs.clear();
    selection.projects[0].assets[0] = { ...selection.projects[0].assets[0], rights: 'owned', ownershipConfirmed: true };
    expect((await preview(selection)).manifest.inventory.find(item => item.projectId === hybrid.id && item.id === 'reference:shared-reference')).toMatchObject({ status: 'included', provenance: expect.objectContaining({ ownership: 'operator-declared' }) });
  });

  it('exports selected exact versions and original rich planning alongside the current draft, with deterministic bytes and checksums', async () => {
    const source = { master: { contentHash: 'a'.repeat(64), durationSec: 120 }, storyboard: Array.from({ length: 26 }, (_, i) => ({ id: `interval-${i}`, purpose: 'Hold', treatment: 'composite', castIds: ['keeper'], setId: 'harbor', wordAnchors: ['cue-example:0'], overlay: { caption: 'Example' } })), api_key: 'synthetic-private-value' };
    source.assets = [{ id: 'panel-example', path: 'panels/scene-example.png', privatePath: '/Users/example/internal/source.png', bytes: [137, 80, 78] }];
    const escaped = JSON.stringify(source).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const guide = artifact('guide-example');
    guide.versions.push({ version: 2, source: 'generated', file: 'music-video/mv-example/dev/guide-example/v2.html' });
    guide.version = 2;
    const original = artifact('original-example', 'html', 'planning-import');
    original.kind = 'other';
    records.get('mv-example').devArtifacts = [guide, original];
    await file(guide.versions[0].file, '<h1>Version one</h1><img src="data:image/png;base64,THIRD_PARTY"><script>privateStuff()</script>');
    await file(guide.versions[1].file, '<h1>Version two</h1>');
    await file(original.versions[0].file, `<pre>${escaped}</pre>`);
    const selection = await select(['artifact:guide-example:v1', 'artifact:original-example:v1']);
    const inventory = await preview(selection);
    const out = await compileMakingOf({ ...selection, previewDigest: inventory.previewDigest }, { download: true });
    const again = await compileMakingOf({ ...selection, previewDigest: inventory.previewDigest }, { download: true });
    expect(out.zip.equals(again.zip)).toBe(true);
    const files = members(out.zip);
    expect(files.get('projects/mv-example/artifacts/guide-example/v1.md').toString()).toContain('Version one');
    expect(out.zip.toString()).not.toMatch(/Version two|THIRD_PARTY|privateStuff|synthetic-private-value|data:image/);
    const originalJSON = JSON.parse(files.get('projects/mv-example/artifacts/original-example/v1.json'));
    expect(originalJSON.storyboard).toHaveLength(26);
    expect(originalJSON.storyboard[0]).toMatchObject({ treatment: 'composite', castIds: ['keeper'], wordAnchors: ['cue-example:0'] });
    expect(originalJSON.assets[0]).toEqual({ id: 'panel-example', path: 'panels/scene-example.png', privatePath: '[path omitted]' });
    expect(out.manifest.inventory.find(item => item.sourceAssetId === 'panel-example')).toMatchObject({ status: 'excluded', delivery: 'metadata-only', reason: 'source-planning-metadata-only' });
    expect(files.get('projects/mv-example/artifacts/original-example/v1-storyboard.csv').toString()).toContain('wordAnchors');
    expect(files.get('projects/mv-example/artifacts/original-example/v1-storyboard.md').toString()).toContain('interval-25');
    const plan = JSON.parse(files.get('projects/mv-example/planning.json'));
    expect(plan.originalScenes).toHaveLength(1);
    expect(plan.shots[0]).toMatchObject({ id: 'shot-example', action: 'Light the lamp', lyricCueIds: ['cue-example'] });
    expect(plan.master).toMatchObject({ durationSec: 120, contentHashStatus: 'not-recorded' });
    expect(plan.readiness.storyboard.approved).toBe(false);
    expect(files.get('projects/mv-example/shots.csv').toString()).toContain("'=unsafe formula");
    expect(out.manifest.inventory.find(item => item.id === 'artifact:guide-example:v1').provenance.reviewStatus).toBe('historical-unverified');
    for (const line of files.get('SHA256SUMS').toString().trim().split('\n')) {
      const [digest, path] = line.split('  ');
      expect(createHash('sha256').update(files.get(path)).digest('hex')).toBe(digest);
    }
    const download = await request(app).post('/api/music-video/making-of/export').send({ ...selection, previewDigest: inventory.previewDigest });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(records.get('mv-example').devArtifacts).toEqual([guide, original]);
  });

  it('includes two independent variants and keeps missing planning and files explicit', async () => {
    const second = fixture({ id: 'mv-hybrid', name: 'Example Hybrid', version: 2, parentProjectId: 'mv-example', scenes: [], devArtifacts: [], productionReview: {} });
    records.set(second.id, second);
    const missing = artifact('missing-example', 'png');
    records.get('mv-example').devArtifacts = [missing];
    const selected = await select(['artifact:missing-example:v1']);
    const catalog = await request(app).get('/api/music-video/mv-hybrid/making-of/catalog');
    selected.projects.push({ projectId: second.id, snapshot: catalog.body.snapshot, assets: [] });
    const result = await preview(selected);
    expect(result.manifest.projects).toHaveLength(2);
    expect(result.manifest.inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'artifact:missing-example:v1', status: 'missing' }),
      expect.objectContaining({ projectId: second.id, id: 'missing:shots', status: 'missing' }),
      expect.objectContaining({ projectId: second.id, id: 'missing:cast-planning', status: 'missing' }),
    ]));
    expect(result.manifest.publication).toBe('not-published');
  });

  it('refuses stale previews and invalid selections before downloading', async () => {
    const selection = await select();
    const result = await preview(selection);
    expect((await request(app).post('/api/music-video/making-of/export').send(selection)).status).toBe(409);
    records.get('mv-example').scenes[0].visualIntent = 'Changed planning';
    expect((await request(app).post('/api/music-video/making-of/export').send({ ...selection, previewDigest: result.previewDigest })).status).toBe(409);
    expect((await request(app).post('/api/music-video/making-of/preview').send({ projects: [{ ...selection.projects[0], projectId: '../escape' }] })).status).toBe(400);
    expect((await request(app).post('/api/music-video/making-of/preview').send({ projects: [selection.projects[0], selection.projects[0]] })).status).toBe(400);
    const fresh = await select(['artifact:not-owned:v1']);
    expect((await request(app).post('/api/music-video/making-of/preview').send(fresh)).status).toBe(400);
  });

  it('excludes cross-project paths, symlinks, uploaded references and oversize files, without reading their bytes', async () => {
    const cross = artifact('cross-example'); cross.versions[0].file = 'music-video/mv-other/dev/cross-example/v1.html';
    const link = artifact('link-example', 'md');
    const uploaded = artifact('upload-example', 'png', 'upload');
    const large = artifact('large-example', 'png');
    const directoryLink = artifact('directory-link-example', 'md');
    const hardLink = artifact('hard-link-example', 'md');
    const forgedImage = artifact('forged-image-example', 'png');
    await file('private-secret.md', 'not-for-export');
    await mkdir(join(root(), 'music-video/mv-example/dev/link-example'), { recursive: true });
    await symlink(join(root(), 'private-secret.md'), join(root(), link.versions[0].file));
    await file('outside-project/v1.md', 'not-for-export');
    await symlink(join(root(), 'outside-project'), join(root(), 'music-video/mv-example/dev/directory-link-example'));
    await mkdir(join(root(), 'music-video/mv-example/dev/hard-link-example'), { recursive: true });
    await hardLinkFile(join(root(), 'private-secret.md'), join(root(), hardLink.versions[0].file));
    await file(forgedImage.versions[0].file, '<svg><image href="file:///private-source"/></svg>');
    await file(large.versions[0].file, ''); await truncate(join(root(), large.versions[0].file), 21 * 1024 * 1024);
    records.get('mv-example').devArtifacts = [cross, link, uploaded, large, directoryLink, hardLink, forgedImage];
    const selected = await select(['artifact:cross-example:v1', 'artifact:link-example:v1', 'artifact:upload-example:v1', 'artifact:large-example:v1', 'artifact:directory-link-example:v1', 'artifact:hard-link-example:v1', 'artifact:forged-image-example:v1']);
    selected.projects[0].assets.forEach(asset => { asset.rights = 'owned'; });
    const result = await preview(selected);
    expect(result.manifest.inventory.filter(item => item.id.startsWith('artifact:')).map(item => item.reason).sort()).toEqual(['invalid-or-oversize-image', 'owner-project-not-selected', 'ownership-unverified', 'shared-file-link', 'size-limit', 'symlink', 'symlink']);
    expect(JSON.stringify(result)).not.toContain('not-for-export');
  });

  it('includes only tagged project-generated gallery images, strips image metadata and detects changed bytes', async () => {
    const project = records.get('mv-example');
    project.castAndSets = { plan: { character: { label: 'Keeper', prompt: 'A keeper' } }, images: { character: { imageId: 'example-owned.png', jobId: 'job-example' } } };
    project.scenes[0].referenceImageId = 'example-reference.png';
    project.scenes[0].takes = [{ kind: 'image', assetId: 'example-reference.png', source: 'imported' }];
    project.visualSpec = { references: [{ imageId: 'example-reference.png' }] };
    jobs.set('job-example', { kind: 'image', params: { musicVideo: { projectId: project.id, castAndSets: { key: 'character' } } }, result: { filename: 'example-owned.png' } });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    await file('images/example-owned.png', png);
    const selected = await select(['cast:character', 'frame:scene-example']);
    const result = await preview(selected);
    expect(result.manifest.inventory.find(item => item.id === 'cast:character')).toMatchObject({ status: 'included', transformation: 'raster re-encoded without metadata' });
    expect(result.manifest.inventory.find(item => item.id === 'frame:scene-example')).toMatchObject({ status: 'excluded', reason: 'ownership-unverified' });
    expect(result.manifest.inventory.find(item => item.kind === 'reference')).toMatchObject({ status: 'excluded', delivery: 'metadata-only', reason: 'ownership-unverified' });
    await file('images/example-owned.png', await sharp(png).negate().png().toBuffer());
    await expect(compileMakingOf({ ...selected, previewDigest: result.previewDigest }, { download: true })).rejects.toMatchObject({ code: 'MAKING_OF_CHANGED' });
    jobs.get('job-example').params.musicVideo.projectId = 'mv-other';
    expect((await preview(selected)).manifest.inventory.find(item => item.id === 'cast:character')).toMatchObject({ status: 'excluded', reason: 'ownership-unverified' });
  });

  it('redacts private paths, tailnet URLs and credentials in selected creative fields and source planning', async () => {
    const project = records.get('mv-example');
    project.concept.prompt = 'A lamp /Users/example/private/file.txt https://private-node.example.ts.net/data api_key=example-secret';
    project.productionReview.draft.cast = 'Bearer synthetic-credential sk-examplesecret';
    project.name = 'Example </a><script>active()</script>';
    project.productionReview.draft.storyboard[0].action = '<script>active()</script> ![external](javascript:active)';
    project.castAndSets = { direction: { notes: '```\n<script>cast()</script>' } };
    const selected = await select();
    const result = await preview(selected);
    const out = await compileMakingOf({ ...selected, previewDigest: result.previewDigest }, { download: true });
    expect(out.zip.toString()).not.toMatch(/\/Users\/|\.ts\.net|example-secret|synthetic-credential|sk-examplesecret/);
    expect(out.zip.toString()).toContain('[credential omitted]');
    const files = members(out.zip);
    expect(files.get('README.md').toString()).not.toContain('<script>');
    expect(files.get('projects/mv-example/storyboard.md').toString()).not.toMatch(/<script>|javascript:/);
    expect(files.get('projects/mv-example/cast-set-sheet.md').toString()).toContain('    {');
  });
});
