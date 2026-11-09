import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeDependencyManifests } from './dependencyManifestProbe.js';

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
const mk = async (files) => {
  const dir = await mkdtemp(join(tmpdir(), 'depprobe-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return dir;
};

describe('probeDependencyManifests', () => {
  it('reports no dependencies for a repo without manifests', async () => {
    expect((await probeDependencyManifests(await mk({ 'index.html': '<p/>' }))).hasDependencies).toBe(false);
  });
  it('reports no dependencies for an empty package.json', async () => {
    const r = await probeDependencyManifests(await mk({ 'package.json': '{"name":"x","scripts":{}}' }));
    expect(r.hasDependencies).toBe(false);
  });
  it('detects package.json deps, including in a subdirectory, ignoring node_modules', async () => {
    expect((await probeDependencyManifests(await mk({ 'server/package.json': '{"dependencies":{"a":"1"}}' }))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests(await mk({ 'node_modules/a/package.json': '{"dependencies":{"b":"1"}}' }))).hasDependencies).toBe(false);
  });
  it('treats comment-only requirements.txt as empty and a populated one as deps', async () => {
    expect((await probeDependencyManifests(await mk({ 'requirements.txt': '# none\n\n' }))).hasDependencies).toBe(false);
    expect((await probeDependencyManifests(await mk({ 'requirements.txt': 'flask==3\n' }))).hasDependencies).toBe(true);
  });
  it('counts third-party GitHub Actions and dependency-bot configs as dependencies', async () => {
    const wf = (uses) => ({ '.github/workflows/ci.yml': `jobs:\n  t:\n    steps:\n      - uses: ${uses}\n` });
    expect((await probeDependencyManifests(await mk(wf('actions/checkout@v4')))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests(await mk(wf('./.github/actions/local')))).hasDependencies).toBe(false);
    expect((await probeDependencyManifests(await mk({ '.github/dependabot.yml': 'version: 2\n' }))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests(await mk({ 'renovate.json': '{}' }))).hasDependencies).toBe(true);
  });
  it('detects Swift packages an Xcode project adds without a Package.swift', async () => {
    const pbx = (body) => ({ 'App.xcodeproj/project.pbxproj': `// !$*UTF8*$!\n{ objects = { ${body} }; }\n` });
    expect((await probeDependencyManifests(await mk(pbx('A1 /* XCRemoteSwiftPackageReference "swift-log" */ = { isa = XCRemoteSwiftPackageReference; };')))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests(await mk(pbx('B1 = { isa = PBXProject; };')))).hasDependencies).toBe(false);
  });
  it('fails open on an unparsable manifest or missing path', async () => {
    expect((await probeDependencyManifests(await mk({ 'package.json': '{bad' }))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests('/nonexistent/path-xyz')).hasDependencies).toBe(true);
  });
});
