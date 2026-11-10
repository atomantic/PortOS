import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const store = vi.hoisted(() => ({ settings: {} }));
vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => store.settings),
  updateSettingsWith: vi.fn(async (mutate) => { store.settings = await mutate(store.settings); return store.settings; }),
}));

const { getUsageRetentionTips, dismissUsageRetentionTip } = await import('./usageRetentionTips.js');

let dir;
const previous = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  store.settings = {};
  dir = await mkdtemp(join(tmpdir(), 'usage-tips-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

const writeClaudeSettings = (value) => writeFile(join(dir, 'settings.json'), JSON.stringify(value));
const ids = (tips) => tips.map((tip) => tip.id);

describe('usage retention tips', () => {
  it('recommends long Claude retention while the setting is missing or short', async () => {
    expect(ids(await getUsageRetentionTips())).toEqual(['claude-cleanup-period']);
    await writeClaudeSettings({ cleanupPeriodDays: 30 });
    const [tip] = await getUsageRetentionTips();
    expect(tip).toMatchObject({ snippet: '"cleanupPeriodDays": 36500', file: join(dir, 'settings.json') });
  });

  it('hides the tip once the CLI config already keeps history for years', async () => {
    await writeClaudeSettings({ cleanupPeriodDays: 36500 });
    expect(await getUsageRetentionTips()).toEqual([]);
  });

  it('still recommends it when the CLI config is unreadable', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json');
    expect(ids(await getUsageRetentionTips())).toEqual(['claude-cleanup-period']);
  });

  it('remembers a dismissal without touching the CLI config, and refuses unknown ids', async () => {
    expect(await dismissUsageRetentionTip('claude-cleanup-period')).toEqual([]);
    expect(store.settings.dismissedUsageTips).toEqual(['claude-cleanup-period']);
    await dismissUsageRetentionTip('claude-cleanup-period');
    expect(store.settings.dismissedUsageTips).toEqual(['claude-cleanup-period']);
    await expect(dismissUsageRetentionTip('nope')).rejects.toMatchObject({ status: 404 });
  });
});
