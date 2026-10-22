/**
 * LIVE evidence for the Docker containment profile (#12844): a real local
 * Linux engine, the pinned Node image, real install and validate runs. Opt-in,
 * because it needs Docker and pulls the pinned image once:
 *
 *   cd server && PORTOS_DOCKER_CONTAINMENT_LIVE=1 npx vitest run services/dockerContainment.live.test.js
 *
 * With the flag set an unready engine FAILS (it never silently skips), so a
 * green run is evidence. The install cases need the public npm registry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { DOCKER_CONTAINMENT_LABEL, dockerContainmentWorkVolume } from '../lib/dockerContainment.js';
import { PORTS } from '../lib/ports.js';
import { pullDockerContainmentImage, runContained } from './dockerContainment.js';
import { resolveDockerEngine } from './dockerEngine.js';

const LIVE = process.env.PORTOS_DOCKER_CONTAINMENT_LIVE === '1';
const NODE_MAJOR = 24;

describe.skipIf(!LIVE)('Docker containment under a real engine', () => {
  let engine;
  let repo;
  let listener;
  let connections = 0;
  const run = (phase, command, extra = {}) => runContained({ worktree: repo, phase, command, timeoutMs: 180_000, ...extra });
  const labeled = async (kind) => (await engine.cli.capture(kind === 'ps'
    ? ['ps', '--all', '--filter', `label=${DOCKER_CONTAINMENT_LABEL}`, '--format', '{{.Names}}']
    : ['network', 'ls', '--filter', `label=${DOCKER_CONTAINMENT_LABEL}`, '--format', '{{.Name}}'])).stdout.trim().split('\n').filter(Boolean);
  const volumeExists = async (name) => (await engine.cli.capture(['volume', 'inspect', name])).success;

  beforeAll(async () => {
    engine = await resolveDockerEngine();
    if (!engine.ready) throw new Error(`No ready local Docker engine (${engine.state}): ${engine.message}`);
    const pulled = await pullDockerContainmentImage({ major: NODE_MAJOR, engine });
    if (!pulled.ok) throw new Error(`Could not pull the pinned Node ${NODE_MAJOR} image: ${pulled.error}`);
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'portos-contained-live-')));
    writeFileSync(join(repo, '.nvmrc'), `${NODE_MAJOR}\n`);
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
      name: 'contained-live', version: '1.0.0', private: true,
      scripts: { preinstall: 'echo planted > planted-by-lifecycle.txt; echo planted > /src/escaped.txt || true', test: 'node -e "process.exit(0)"' },
    }, null, 2)}\n`);
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '.'], { cwd: repo });
    listener = createServer((socket) => { connections += 1; socket.destroy(); });
    await new Promise((resolve) => listener.listen(0, '0.0.0.0', resolve));
  }, 600_000);

  afterAll(async () => {
    listener?.close();
    if (repo) {
      await engine?.cli.capture(['volume', 'rm', '--force', dockerContainmentWorkVolume(repo)]);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('runs as non-root with no host home, no credential store and no Docker socket', async () => {
    const home = homedir();
    const result = await run('validate', [
      'id -u',
      `test -e ${JSON.stringify(home)} && echo HOME_VISIBLE || echo HOME_ABSENT`,
      `cat ${JSON.stringify(join(home, '.ssh', 'id_ed25519'))} 2>/dev/null && echo SSH_READ || echo SSH_DENIED`,
      'ls /var/run/docker.sock /run/docker.sock 2>/dev/null && echo SOCKET_PRESENT || echo SOCKET_ABSENT',
      'env | sort',
    ].join('; '));
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, contained: true });
    const lines = result.log.split('\n');
    expect(Number(lines.find((line) => /^\d+$/.test(line)))).toBeGreaterThan(0);
    expect(result.log).toContain('HOME_ABSENT');
    expect(result.log).toContain('SSH_DENIED');
    expect(result.log).toContain('SOCKET_ABSENT');
    expect(result.log).not.toMatch(/PORTOS_API_TOKEN|ANTHROPIC|OPENAI|GITHUB_TOKEN|GH_TOKEN|PGPASSWORD/);
  });

  it('gives validate no network at all: not the host gateway, not PortOS, not the internet', async () => {
    const port = listener.address().port;
    const probe = `const net = require('net'); const targets = [['host.docker.internal', ${port}], ['host.docker.internal', ${PORTS.API}], ['172.17.0.1', ${port}], ['1.1.1.1', 443], ['127.0.0.1', ${PORTS.API}]]; Promise.all(targets.map(([host, port]) => new Promise((done) => { const s = net.connect({ host, port, timeout: 3000 }); s.on('connect', () => { s.destroy(); done(host + ':' + port + '=OPEN'); }); s.on('error', (e) => done(host + ':' + port + '=' + e.code)); s.on('timeout', () => { s.destroy(); done(host + ':' + port + '=TIMEOUT'); }); }))).then((r) => console.log('PROBE ' + r.join(' ')));`;
    // Only loopback (plus the kernel's down-by-default tunnel stubs), and no route anywhere.
    const result = await run('validate', `echo IFACES $(ls /sys/class/net); echo ROUTES $(tail -n +2 /proc/net/route | wc -l); node -e ${JSON.stringify(probe)}`);
    expect(result.status).toBe('completed');
    const ifaces = result.log.split('\n').find((line) => line.startsWith('IFACES ')).split(' ').slice(1);
    expect(ifaces).toContain('lo');
    expect(ifaces.filter((name) => /^(eth|en|veth|wl|br)/.test(name))).toEqual([]);
    expect(result.log).toContain('ROUTES 0');
    const report = result.log.split('\n').find((line) => line.startsWith('PROBE '));
    expect(report).toBeTruthy();
    expect(report).not.toContain('=OPEN');
    expect(connections).toBe(0);
  });

  it('lets install reach registry.npmjs.org through the proxy and nothing else', async () => {
    const direct = `require('net').connect({ host: '1.1.1.1', port: 443, timeout: 3000 }).on('connect', () => console.log('DIRECT_OPEN')).on('error', (e) => console.log('DIRECT_' + e.code)).on('timeout', function () { console.log('DIRECT_TIMEOUT'); this.destroy(); })`;
    const result = await run('install', [
      'npm view is-number version && echo REGISTRY_OK',
      '(npm view --registry https://example.com/ is-number version >/dev/null 2>&1 && echo OTHER_OK || echo OTHER_REFUSED)',
      `node -e ${JSON.stringify(direct)}`,
    ].join('; '));
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.log).toContain('REGISTRY_OK');
    expect(result.log).toContain('OTHER_REFUSED');
    expect(result.log).not.toContain('DIRECT_OPEN');
    expect(connections).toBe(0);
  });

  it("keeps a lifecycle script's writes out of the host worktree and returns tracked edits as a patch", async () => {
    const before = readdirSync(repo).sort();
    const result = await run('install', 'npm install --no-audit && echo two >> tracked.txt');
    expect(result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(result.log).toContain('planted-by-lifecycle');
    expect(readdirSync(repo).sort()).toEqual(before);
    expect(existsSync(join(repo, 'planted-by-lifecycle.txt'))).toBe(false);
    expect(existsSync(join(repo, 'escaped.txt'))).toBe(false);
    expect(result.patch).toContain('+two');
    expect(result.patch).not.toContain('planted');
    // The volume the install left serves the validate phase.
    const validate = await run('validate', 'test -f planted-by-lifecycle.txt && npm test');
    expect(validate).toMatchObject({ status: 'completed', exitCode: 0 });
  });

  it('kills and removes the container and its work volume on timeout', async () => {
    const result = await run('validate', 'sleep 600', { timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: 'terminated', reason: 'timeout', exitCode: null });
    expect(await labeled('ps')).toEqual([]);
    expect(await volumeExists(dockerContainmentWorkVolume(repo))).toBe(false);
    expect((await labeled('network')).filter((name) => name.startsWith('portos-contained-net-'))).toEqual([]);
  });
});
