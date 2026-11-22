import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { discoverEcosystemConfig } from './ecosystemPortEdits.js';

describe('discoverEcosystemConfig', () => {
  it('marks attributable configuration editable and returns public process shapes', () => {
    const content = `const PM2_HOME = \`\${require('os').homedir()}/.pm2-example\`;
module.exports = { apps: [
  { name: 'example-api', script: 'server.js', env: { PORT: 6100, PM2_HOME } },
  { name: 'example-ui', script: 'vite', cwd: './client', env: { VITE_PORT: 6101 } },
] };`;
    const result = discoverEcosystemConfig(content);
    expect(result.portsEditable).toBe(true);
    expect(result.pm2Home).toBe(`${homedir()}/.pm2-example`);
    expect(result.processes).toEqual([
      { name: 'example-api', ports: { api: 6100 }, port: 6100, cwd: null, usesVite: false },
      { name: 'example-ui', ports: { devUi: 6101 }, port: 6101, cwd: './client', usesVite: true },
    ]);
    expect(result.processes[0]).not.toHaveProperty('sources');
  });

  it('discovers apps the writers refuse, without making them editable', () => {
    const content = `module.exports = { apps: [
  { name: 'example-api', env: { PORT: 6100 } },
  { name: process.env.DYNAMIC_NAME, env: { PORT: 6101 } },
  { name: 'example-worker', ports: loadPorts(), env: { WORKER_PORT: 6102 } },
] };
console.log('after export');`;
    const result = discoverEcosystemConfig(content);
    expect(result.portsEditable).toBe(false);
    expect(result.processes.map(({ name, ports }) => [name, ports])).toEqual([
      ['example-api', { api: 6100 }],
      ['example-worker', { worker: 6102 }],
    ]);
  });

  it('reads past a recoverable redeclaration but never treats the redeclared name as static', () => {
    const content = `const NAME = 'example-api';
const NAME = 'example-other';
const apps = [{ name: NAME, env: { PORT: 6100 } }, { name: 'example-worker', env: { PORT: 6101 } }];
module.exports = { apps };`;
    const result = discoverEcosystemConfig(content);
    expect(result.portsEditable).toBe(false);
    expect(result.processes.map(proc => proc.name)).toEqual(['example-worker']);
  });

  it('drops an alias chain written through a member during lenient discovery', () => {
    const content = `const app = { name: 'example-api', env: { PORT: 6100 } };
const env = app.env;
env.PORT = 6200;
module.exports = { apps: [app] };`;
    expect(discoverEcosystemConfig(content)).toMatchObject({ processes: [], portsEditable: false });
  });

  it('uses the supplied username resolver and leaves unknown template expressions verbatim', () => {
    const content = 'const PM2_HOME = `/srv/${require("os").userInfo().username}/${process.env.SUFFIX}`;\nmodule.exports = { apps: [] };';
    expect(discoverEcosystemConfig(content, { currentUsername: () => 'example-user' }).pm2Home)
      .toBe('/srv/example-user/${process.env.SUFFIX}');
  });

  it('discovers nothing from source that cannot be parsed', () => {
    expect(discoverEcosystemConfig('module.exports = { apps: [ { name: "x" ')).toEqual({
      processes: [], pm2Home: null, portsEditable: false,
    });
  });
});
