import { describe, expect, it, vi } from 'vitest';
import { DOCKER_FALLBACK_PATHS, resolveDockerEngine } from './dockerEngine.js';

const version = ({ os = 'linux', platform = null } = {}) => JSON.stringify({
  Client: { Version: '29.0.0' },
  Server: { Version: '29.0.0', Os: os, Arch: 'arm64', ...(platform ? { Platform: { Name: platform } } : {}) },
});
const contextRow = (name, endpoint, current = false) => JSON.stringify({ Name: name, Current: current, DockerEndpoint: endpoint });

/** A docker CLI double: `contexts` rows, and which endpoints answer `docker version`. */
function fakeDocker({ contexts = [], answering = {}, contextLsFails = false }) {
  const calls = [];
  const createCli = (bin, { globalArgs = [] } = {}) => ({
    bin, globalArgs,
    capture: vi.fn(async (args) => {
      calls.push([...globalArgs, ...args]);
      if (args[0] === 'context') return contextLsFails ? { success: false, stdout: '', stderr: 'unknown command' } : { success: true, stdout: contexts.join('\n') };
      const key = globalArgs[1];
      return answering[key] ? { success: true, stdout: answering[key] } : { success: false, stdout: JSON.stringify({ Client: { Version: '29.0.0' } }), stderr: 'Cannot connect to the Docker daemon' };
    }),
  });
  return { createCli, calls };
}

describe('resolveDockerEngine', () => {
  it('finds the CLI on PATH, else in the Docker Desktop bundle', async () => {
    const docker = fakeDocker({ contexts: [contextRow('default', 'unix:///var/run/docker.sock', true)], answering: { default: version() } });
    const resolve = (which, exists) => resolveDockerEngine({ which, exists, createCli: docker.createCli, env: {}, platform: 'linux' });
    expect((await resolve(async () => '/usr/bin/docker', () => false)).cli.bin).toBe('/usr/bin/docker');
    const bundle = '/Applications/Docker.app/Contents/Resources/bin/docker';
    expect(DOCKER_FALLBACK_PATHS).toContain(bundle);
    expect((await resolve(async () => null, (path) => path === bundle)).cli.bin).toBe(bundle);
    expect(await resolve(async () => null, () => false)).toMatchObject({ state: 'docker-missing', ready: false, cli: null });
  });

  it('prefers a running Docker Desktop over the active native context, and pins the run to it', async () => {
    const docker = fakeDocker({
      contexts: [contextRow('default', 'unix:///var/run/docker.sock', true), contextRow('desktop-linux', 'unix:///home/example/.docker/desktop/docker.sock')],
      answering: { 'desktop-linux': version({ platform: 'Docker Desktop 4.50.0' }), default: version() },
    });
    const engine = await resolveDockerEngine({ bin: '/usr/bin/docker', createCli: docker.createCli, env: {}, platform: 'linux' });
    expect(engine).toMatchObject({ state: 'ready', engine: { kind: 'desktop', context: 'desktop-linux' } });
    expect(engine.cli.globalArgs).toEqual(['--context', 'desktop-linux']);
  });

  it('falls back to native Docker Engine when Docker Desktop is installed but stopped', async () => {
    const docker = fakeDocker({
      contexts: [contextRow('default', 'unix:///var/run/docker.sock'), contextRow('desktop-linux', 'unix:///home/example/.docker/desktop/docker.sock', true)],
      answering: { default: version() },
    });
    const engine = await resolveDockerEngine({ bin: '/usr/bin/docker', createCli: docker.createCli, env: {}, platform: 'linux' });
    expect(engine).toMatchObject({ state: 'ready', engine: { kind: 'native', context: 'default' } });
    expect(engine.cli.globalArgs).toEqual(['--context', 'default']);
  });

  it('reports stopped when no local engine answers', async () => {
    const docker = fakeDocker({ contexts: [contextRow('default', 'unix:///var/run/docker.sock', true)] });
    const engine = await resolveDockerEngine({ bin: '/usr/bin/docker', createCli: docker.createCli, env: {}, platform: 'linux' });
    expect(engine).toMatchObject({ state: 'docker-stopped', ready: false, cli: null });
    expect(engine.message).toContain('Cannot connect to the Docker daemon');
  });

  it.each([
    ['an ssh context', { contexts: [contextRow('build-box', 'ssh://builder@example.com', true), contextRow('default', 'unix:///var/run/docker.sock')] }, {}],
    ['a tcp DOCKER_HOST', { contexts: [] }, { DOCKER_HOST: 'tcp://192.0.2.10:2376' }],
  ])('refuses %s without ever asking it', async (_label, setup, env) => {
    const docker = fakeDocker({ ...setup, answering: { 'build-box': version(), 'tcp://192.0.2.10:2376': version() } });
    const engine = await resolveDockerEngine({ bin: '/usr/bin/docker', createCli: docker.createCli, env, platform: 'linux' });
    expect(engine).toMatchObject({ state: 'docker-remote-refused', ready: false });
    expect(docker.calls.some((call) => call.includes('build-box') || call.includes('tcp://192.0.2.10:2376'))).toBe(false);
  });

  it('requires Linux containers and refuses Windows hosts', async () => {
    const windowsContainers = fakeDocker({ contexts: [contextRow('default', 'npipe:////./pipe/docker_engine', true)], answering: { default: version({ os: 'windows' }) } });
    expect(await resolveDockerEngine({ bin: 'docker', createCli: windowsContainers.createCli, env: {}, platform: 'linux' })).toMatchObject({ state: 'docker-unsupported' });
    const linux = fakeDocker({ contexts: [contextRow('default', 'npipe:////./pipe/docker_engine', true)], answering: { default: version() } });
    expect(await resolveDockerEngine({ bin: 'docker', createCli: linux.createCli, env: {}, platform: 'win32' })).toMatchObject({ state: 'docker-unsupported', ready: false });
  });

  it('uses the native socket when the CLI cannot list contexts', async () => {
    const docker = fakeDocker({ contextLsFails: true, answering: { 'unix:///var/run/docker.sock': version() } });
    const engine = await resolveDockerEngine({ bin: '/usr/bin/docker', createCli: docker.createCli, env: {}, platform: 'linux' });
    expect(engine).toMatchObject({ state: 'ready', engine: { kind: 'native' } });
    expect(engine.cli.globalArgs).toEqual(['--host', 'unix:///var/run/docker.sock']);
  });
});
