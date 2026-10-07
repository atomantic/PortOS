import { describe, expect, it } from 'vitest';
import { buildThreeImportMap, importsThree, inlineThreeVendor } from './threeVendorImportMap.js';

const decode = (url) => decodeURIComponent(url.replace(/^data:text\/javascript;charset=utf-8,/, ''));
const FILES = [
  { path: 'three.core.js', text: 'export const REVISION = "x";' },
  { path: 'three.module.js', text: "import { REVISION } from './three.core.js';\nexport { REVISION } from './three.core.js';" },
  { path: 'addons/shaders/CopyShader.js', text: 'export const CopyShader = {};' },
  { path: 'addons/postprocessing/EffectComposer.js', text: "import { Vector2 } from 'three';\nimport { CopyShader } from '../shaders/CopyShader.js';\nimport { Pass } from './Pass.js';" },
  { path: 'addons/postprocessing/Pass.js', text: 'export class Pass {}' },
];

describe('three vendor import map', () => {
  it('maps three, every addon, and the ids the vendored files use between themselves, with relative imports rewritten to those ids', () => {
    const { imports } = buildThreeImportMap(FILES);
    expect(Object.keys(imports).sort()).toEqual([
      'three', 'three-vendor/addons/postprocessing/EffectComposer.js', 'three-vendor/addons/postprocessing/Pass.js',
      'three-vendor/addons/shaders/CopyShader.js', 'three-vendor/three.core.js', 'three-vendor/three.module.js',
      'three/addons/postprocessing/EffectComposer.js', 'three/addons/postprocessing/Pass.js', 'three/addons/shaders/CopyShader.js',
    ]);
    expect(imports.three).toBe(imports['three-vendor/three.module.js']);
    expect(decode(imports.three)).toBe("import { REVISION } from 'three-vendor/three.core.js';\nexport { REVISION } from 'three-vendor/three.core.js';");
    const composer = decode(imports['three/addons/postprocessing/EffectComposer.js']);
    // Bare `three` is left for the map; sibling and parent-directory imports are resolved.
    expect(composer).toContain("from 'three';");
    expect(composer).toContain("from 'three-vendor/addons/shaders/CopyShader.js'");
    expect(composer).toContain("from 'three-vendor/addons/postprocessing/Pass.js'");
    // Every rewritten target is itself in the map.
    for (const target of composer.matchAll(/'(three-vendor\/[^']+)'/g)) expect(imports).toHaveProperty([target[1]]);
  });

  it("replaces the page's own import map and cannot be broken out of through module text", () => {
    const html = '<html><head><script type="importmap">{"imports":{"three":"https://cdn.example.com/t.js"}}</script></head><body></body></html>';
    const page = inlineThreeVendor(html, [...FILES, { path: 'addons/utils/Evil.js', text: 'export default "</script><script>alert(1)</script>";' }]);
    expect(page).not.toContain('cdn.example.com');
    expect(page.match(/<script type="importmap">/g)).toHaveLength(1);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page.startsWith('<html><head><script type="importmap">')).toBe(true);
  });

  it('detects bare three imports only', () => {
    expect(importsThree("import * as THREE from 'three';")).toBe(true);
    expect(importsThree('import { Pass } from "three/addons/postprocessing/Pass.js"')).toBe(true);
    expect(importsThree("import './three-local.js'")).toBe(false);
    expect(importsThree('')).toBe(false);
    expect(importsThree(null)).toBe(false);
  });
});
