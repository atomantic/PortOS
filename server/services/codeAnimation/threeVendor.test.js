import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { THREE_ADDON_ALLOWLIST, THREE_IMPORT_MAP, importsThree, injectThreeImportMap, readThreeVendor, threeStagedFiles } from './threeVendor.js';

describe('three.js vendor set', () => {
  it('ships only the allowlisted addons, and every relative import inside them stays inside the set', async () => {
    const { files } = await readThreeVendor();
    const paths = files.map((file) => file.path);
    expect(paths.filter((path) => path.startsWith('addons/'))).toEqual(THREE_ADDON_ALLOWLIST.map((name) => `addons/${name}`));
    // The loader fails closed on any relative import outside the set (readThreeVendor
    // would have rejected above); also pin that the graph is not vacuous: EffectComposer
    // imports CopyShader from a sibling directory, so that file must be vendored.
    expect(paths).toContain('addons/shaders/CopyShader.js');
    expect(files.find((file) => file.path === 'addons/postprocessing/EffectComposer.js').data.toString('utf8')).toContain("'../shaders/CopyShader.js'");
  });

  it('stages every file under vendor/ with a dependencies.json whose hashes match the bytes', async () => {
    const staged = await threeStagedFiles();
    const manifest = JSON.parse(staged.find((file) => file.rel === 'dependencies.json').data.toString());
    expect(manifest.network).toBe(false);
    expect(manifest.packages[0]).toMatchObject({ name: 'three', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    const byRel = new Map(staged.map((file) => [file.rel, file.data]));
    for (const { path, sha256 } of manifest.packages[0].files) {
      expect(createHash('sha256').update(byRel.get(path)).digest('hex')).toBe(sha256);
    }
    expect(byRel.has('vendor/three.module.js')).toBe(true);
    expect(byRel.has('vendor/three.core.js')).toBe(true);
  });
});

describe('three import map injection', () => {
  it('detects bare three and addon imports but not look-alikes', () => {
    expect(importsThree("<script type=\"module\">import * as THREE from 'three';</script>")).toBe(true);
    expect(importsThree('import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"')).toBe(true);
    expect(importsThree("import x from './three-helpers.js'; const three = 3;")).toBe(false);
    expect(importsThree('<canvas></canvas>')).toBe(false);
  });

  it("replaces the page's own import map (a CDN one included) with the host's, first in <head>", () => {
    const html = '<html><head><script type="importmap">{"imports":{"three":"https://cdn.example.com/three.js"}}</script><title>x</title></head><body></body></html>';
    const page = injectThreeImportMap(html);
    expect(page).not.toContain('cdn.example.com');
    expect(page.startsWith(`<html><head><script type="importmap">${JSON.stringify(THREE_IMPORT_MAP)}</script>`)).toBe(true);
    expect(page.match(/type="importmap"/g)).toHaveLength(1);
  });
});
