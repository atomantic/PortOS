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
  it('fails open on an unparsable manifest or missing path', async () => {
    expect((await probeDependencyManifests(await mk({ 'package.json': '{bad' }))).hasDependencies).toBe(true);
    expect((await probeDependencyManifests('/nonexistent/path-xyz')).hasDependencies).toBe(true);
  });
});
