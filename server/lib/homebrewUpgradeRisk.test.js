import { describe, expect, it } from 'vitest';
import { classifyHomebrewOutdated, classifyHomebrewUpgrade, postgresFormulaFor } from './homebrewUpgradeRisk.js';

const formula = (name, installed, current, extra = {}) => ({ name, installed_versions: [installed], current_version: current, pinned: false, kind: 'formula', ...extra });
const info = (name, { deps = [], installedDeps = [] } = {}) => ({
  name,
  dependencies: deps,
  installed: [{ runtime_dependencies: installedDeps.map(([full_name, declared_directly]) => ({ full_name, declared_directly })) }],
});
const uses = { postgresFormula: 'postgresql@17' };

describe('postgresFormulaFor', () => {
  it('names the Homebrew formula only for a native Homebrew build', () => {
    expect(postgresFormulaFor({ mode: 'native', major: 17, build: 'Homebrew' })).toBe('postgresql@17');
    expect(postgresFormulaFor({ mode: 'docker', major: 17, build: 'Debian' })).toBeNull();
    expect(postgresFormulaFor({ mode: 'native', major: 17, build: 'Postgres.app' })).toBeNull();
    expect(postgresFormulaFor(null)).toBeNull();
  });
});

describe('classifyHomebrewUpgrade', () => {
  it('marks an extension whose new version drops the database PortOS runs on as breaking', () => {
    const result = classifyHomebrewUpgrade(formula('pgvector', '0.8.1', '0.8.7_1'),
      info('pgvector', { deps: ['postgresql@18', 'postgresql@19'], installedDeps: [['postgresql@17', true], ['postgresql@18', true]] }), uses);
    expect(result.risk).toBe('breaking');
    expect(result.reasons[0]).toContain('no longer supports postgresql@17');
    expect(result.checks).toContain('postgres-extensions');
  });

  it('treats an extension that still builds for that database as a check-after upgrade', () => {
    const result = classifyHomebrewUpgrade(formula('pgvector', '0.8.0', '0.8.1'),
      info('pgvector', { deps: ['postgresql@17', 'postgresql@18'], installedDeps: [['postgresql@17', true], ['postgresql@18', true]] }), uses);
    expect(result.risk).toBe('caution');
    expect(result.reasons[0]).toMatch(/Extension for PortOS's database/);
  });

  it('ignores transitive versioned libraries and notes dropped direct ones', () => {
    const transitive = classifyHomebrewUpgrade(formula('wget', '1.24', '1.25'),
      info('wget', { deps: ['openssl@3'], installedDeps: [['openssl@3', true], ['icu4c@77', false]] }), uses);
    expect(transitive.risk).toBe('safe');
    const dropped = classifyHomebrewUpgrade(formula('tool', '1.0', '1.1'),
      info('tool', { deps: ['python@3.13'], installedDeps: [['python@3.12', true]] }), uses);
    expect(dropped).toMatchObject({ risk: 'caution', reasons: ['1.1 drops python@3.12.'] });
  });

  it('flags the database, its unversioned major move, Node, ffmpeg and linked libraries', () => {
    expect(classifyHomebrewUpgrade(formula('postgresql@17', '17.5', '17.6'), info('postgresql@17'), uses).risk).toBe('caution');
    expect(classifyHomebrewUpgrade(formula('postgresql', '17.6', '18.1'), info('postgresql'), {}).risk).toBe('breaking');
    expect(classifyHomebrewUpgrade(formula('node', '24.1.0', '26.0.0'), info('node'), { nodeFormula: 'node' }).risk).toBe('breaking');
    expect(classifyHomebrewUpgrade(formula('node', '24.1.0', '26.0.0'), info('node'), {}).risk).toBe('safe');
    expect(classifyHomebrewUpgrade(formula('ffmpeg', '7.1', '8.0'), info('ffmpeg'), { ffmpegFormula: 'ffmpeg' }).reasons[0]).toMatch(/new major/);
    const gettext = classifyHomebrewUpgrade(formula('gettext', '0.26', '1.0'), info('gettext'), { linkedBy: { gettext: ['pyenv Python 3.8.9'] } });
    expect(gettext).toMatchObject({ risk: 'caution', checks: ['python'] });
    expect(gettext.reasons[0]).toContain('pyenv Python 3.8.9');
  });

  it('reports a pinned package as held, whatever else it risks', () => {
    const result = classifyHomebrewUpgrade(formula('pgvector', '0.8.1', '0.8.7_1', { pinned: true, pinned_version: '0.8.1' }),
      info('pgvector', { deps: ['postgresql@18'], installedDeps: [['postgresql@17', true]] }), uses);
    expect(result.risk).toBe('pinned');
    expect(result.reasons[0]).toContain('brew unpin pgvector');
  });
});

describe('classifyHomebrewOutdated', () => {
  it('classifies formulae and casks, most risky first', () => {
    const outdated = {
      formulae: [{ name: 'wget', installed_versions: ['1.24'], current_version: '1.25' }, { name: 'pgvector', installed_versions: ['0.8.1'], current_version: '0.8.7_1' }],
      casks: [{ name: 'some-app', installed_versions: ['1.0'], current_version: '1.1' }],
    };
    const infos = [info('pgvector', { deps: ['postgresql@18'], installedDeps: [['postgresql@17', true]] }), info('wget')];
    const result = classifyHomebrewOutdated(outdated, infos, uses);
    expect(result.map((pkg) => [pkg.name, pkg.kind, pkg.risk])).toEqual([
      ['pgvector', 'formula', 'breaking'], ['some-app', 'cask', 'safe'], ['wget', 'formula', 'safe'],
    ]);
  });
});
