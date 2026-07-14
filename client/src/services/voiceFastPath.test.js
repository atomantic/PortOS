import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the on-device model client so the routing decision is tested in
// isolation (no real Prompt API in the test environment).
vi.mock('./browserLlm', () => ({
  promptNano: vi.fn(),
  nanoAvailability: vi.fn(),
  NANO_AVAILABILITY: {
    AVAILABLE: 'available',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    UNAVAILABLE: 'unavailable',
    NO_API: 'no-api',
  },
}));

import { promptNano, nanoAvailability } from './browserLlm';
import {
  resolveTurn, resolveNavIntent, isActionIntent, isCapabilityQuery, looksLikeConfirmationFollowup,
  cleanNanoReply, isEscalate, buildRouterSystemPrompt, TIER,
} from './voiceFastPath';

const NAV = [
  { id: 'nav.system.tasks', path: '/tasks', label: 'Tasks', aliases: ['tasks', 'todo', 'task list'] },
  { id: 'nav.brain.daily', path: '/brain/daily-log', label: 'Daily Log', aliases: ['daily-log', 'journal'] },
  { id: 'nav.system.pipeline', path: '/pipeline', label: 'Pipeline', aliases: ['pipeline'] },
  // Real-manifest shapes that exposed the matching bugs: the specific settings
  // sub-pages (hyphenated / reversed-word-order aliases) must beat the generic
  // "settings", and a bare-label "Settings" (MeatSpace) must not win over them.
  { id: 'nav.meatspace.settings', path: '/meatspace/settings', label: 'Settings', aliases: ['meatspace-settings'] },
  { id: 'nav.settings.general', path: '/settings/general', label: 'General', aliases: ['settings', 'settings-general', 'general'] },
  { id: 'nav.settings.voice', path: '/settings/voice', label: 'Voice', aliases: ['settings-voice', 'voice', 'voice-settings'] },
  { id: 'nav.settings.catalog', path: '/settings/catalog', label: 'Catalog Types', aliases: ['settings-catalog', 'catalog-types'] },
  { id: 'nav.settings.database', path: '/settings/database', label: 'Database', aliases: ['settings-database', 'database'] },
];

describe('resolveNavIntent', () => {
  it('navigates on an explicit lead-in verb + alias', () => {
    expect(resolveNavIntent('go to tasks', NAV)).toEqual({ path: '/tasks', label: 'Tasks' });
    expect(resolveNavIntent('open the daily log', NAV)).toEqual({ path: '/brain/daily-log', label: 'Daily Log' });
    expect(resolveNavIntent('take me to the tasks page', NAV)).toEqual({ path: '/tasks', label: 'Tasks' });
  });

  it('matches on the label case-insensitively', () => {
    expect(resolveNavIntent('open Pipeline', NAV)).toEqual({ path: '/pipeline', label: 'Pipeline' });
  });

  it('returns null without a navigation lead-in (a mere mention should not teleport)', () => {
    expect(resolveNavIntent('how are my tasks going', NAV)).toBeNull();
    expect(resolveNavIntent('tasks', NAV)).toBeNull();
  });

  it('matches a hyphenated alias spoken with a space, beating the generic word it embeds', () => {
    // "voice settings" must resolve to /settings/voice (alias "voice-settings"),
    // NOT the generic "Settings" (meatspace) it happens to contain. Regression.
    expect(resolveNavIntent('open voice settings', NAV)).toEqual({ path: '/settings/voice', label: 'Voice' });
    expect(resolveNavIntent('take me to the voice settings', NAV)).toEqual({ path: '/settings/voice', label: 'Voice' });
  });

  it('word-overlaps a reversed-order alias — "catalog settings" → Catalog, not generic Settings', () => {
    // alias is "settings-catalog" (reversed word order); word overlap still wins.
    expect(resolveNavIntent('go to catalog settings', NAV)).toEqual({ path: '/settings/catalog', label: 'Catalog Types' });
  });

  it('resolves a terse "<page> settings" WITHOUT a nav lead-in', () => {
    // "database settings" (no "go to") must navigate rather than fall to the
    // server — this was the phrase that hit the tool-calling error path.
    expect(resolveNavIntent('database settings', NAV)).toEqual({ path: '/settings/database', label: 'Database' });
  });

  it('prefers the explicit "settings" alias (General) over the incidental "Settings" label (MeatSpace)', () => {
    expect(resolveNavIntent('go to settings', NAV)).toEqual({ path: '/settings/general', label: 'General' });
  });

  it('does not resolve a bare common word to a page that merely embeds it', () => {
    // "log" is not an exact alias of any entry (Daily Log's aliases are
    // daily-log/journal); a single common word must not resolve via coversAll.
    expect(resolveNavIntent('go to log', NAV)).toBeNull();
  });

  it('does not navigate on ordinary chatter without a lead-in', () => {
    expect(resolveNavIntent('tell me a joke', NAV)).toBeNull();
    expect(resolveNavIntent('what time is it', NAV)).toBeNull();
    expect(resolveNavIntent('good daily settings', NAV)).toBeNull(); // partial word overlap only
  });

  it('returns null when the target matches nothing', () => {
    expect(resolveNavIntent('go to the moon base', NAV)).toBeNull();
  });

  it('tolerates a missing/empty manifest', () => {
    expect(resolveNavIntent('go to tasks', [])).toBeNull();
    expect(resolveNavIntent('go to tasks', undefined)).toBeNull();
  });
});

describe('isActionIntent', () => {
  it('flags clear tool/action turns', () => {
    ['save this note', 'remind me to call mom', 'add a task called foo', 'start dictation',
      'what did I say yesterday', 'delete that', "restart the server", "what's on my calendar"]
      .forEach((t) => expect(isActionIntent(t), t).toBe(true));
  });

  it('does not flag plain conversation / general questions', () => {
    ["what's the capital of France", 'how are you today', 'tell me a joke', "what's two plus two"]
      .forEach((t) => expect(isActionIntent(t), t).toBe(false));
  });
});

describe('isCapabilityQuery', () => {
  it('flags meta/capability questions (so the server answers, not tool-less Nano)', () => {
    ['what tools do you have', 'what are my options', 'what can you do', 'what are your capabilities', 'which tools do you have']
      .forEach((t) => expect(isCapabilityQuery(t), t).toBe(true));
  });
  it('does not flag ordinary questions', () => {
    ['what time is it', "what's the weather", 'what did you say']
      .forEach((t) => expect(isCapabilityQuery(t), t).toBe(false));
  });
});

describe('looksLikeConfirmationFollowup', () => {
  it('is true after a gate prompt', () => {
    expect(looksLikeConfirmationFollowup('do it', 'That looks destructive — confirm by saying "yes" or "cancel".')).toBe(true);
  });
  it('is true for a bare yes/no/cancel', () => {
    expect(looksLikeConfirmationFollowup('yes', '')).toBe(true);
    expect(looksLikeConfirmationFollowup('cancel', '')).toBe(true);
  });
  it('is false for a normal sentence that merely starts with yes', () => {
    expect(looksLikeConfirmationFollowup('yes I really like that idea', '')).toBe(false);
  });
});

describe('cleanNanoReply', () => {
  it('strips wrapping quotes and caps at two sentences', () => {
    expect(cleanNanoReply('"Sure thing. Here is more. And even more."')).toBe('Sure thing. Here is more.');
  });
  it('returns empty for blank input', () => {
    expect(cleanNanoReply('')).toBe('');
    expect(cleanNanoReply(null)).toBe('');
  });
});

describe('isEscalate', () => {
  it('detects the escalate token (leading, quoted, or short)', () => {
    expect(isEscalate('ESCALATE')).toBe(true);
    expect(isEscalate('"ESCALATE"')).toBe(true);
    expect(isEscalate('escalate.')).toBe(true);
  });
  it('does not treat a normal reply as escalate', () => {
    expect(isEscalate('The weather is sunny today.')).toBe(false);
    expect(isEscalate('You could escalate that issue to your manager if it keeps happening.')).toBe(false);
  });
});

describe('buildRouterSystemPrompt', () => {
  it('includes the persona name and the ESCALATE contract', () => {
    const p = buildRouterSystemPrompt({ name: 'Alfred', speechStyle: 'warm' });
    expect(p).toContain('Alfred');
    expect(p).toContain('ESCALATE');
    expect(p).toContain('warm');
  });
});

describe('resolveTurn', () => {
  const base = {
    fastPath: { enabled: true, triggers: true, browserLlm: true, browser: { temperature: 0.7, topK: 3 } },
    personality: { name: 'Alfred' },
    navEntries: NAV,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    nanoAvailability.mockResolvedValue('available');
  });

  it('routes an empty transcript to the server', async () => {
    expect(await resolveTurn('   ', base)).toMatchObject({ tier: TIER.SERVER });
  });

  it('always defers to the server while dictation is active', async () => {
    const d = await resolveTurn('go to tasks', { ...base, dictationActive: true });
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'dictation' });
    expect(promptNano).not.toHaveBeenCalled();
  });

  it('defers a confirmation follow-up to the server', async () => {
    const d = await resolveTurn('yes', { ...base, lastAssistantReply: 'confirm by saying yes or cancel' });
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'confirm-followup' });
  });

  it('resolves nav via tier 1 without touching Nano', async () => {
    const d = await resolveTurn('go to tasks', base);
    expect(d).toEqual({ tier: TIER.TRIGGER, kind: 'navigate', path: '/tasks', label: 'Tasks' });
    expect(promptNano).not.toHaveBeenCalled();
  });

  it('escalates a clear action intent to the server without touching Nano', async () => {
    const d = await resolveTurn('save this to my brain inbox', base);
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'action-intent' });
    expect(promptNano).not.toHaveBeenCalled();
  });

  it('escalates capability/meta questions to the server (Nano would falsely claim no tools)', async () => {
    const d = await resolveTurn('what tools do you have', base);
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'capability-query' });
    expect(promptNano).not.toHaveBeenCalled();
  });

  it('answers a conversational turn via Nano (tier 2)', async () => {
    promptNano.mockResolvedValue('It is sunny and warm today.');
    const d = await resolveTurn('what is the weather like', base);
    expect(d).toEqual({ tier: TIER.NANO, reply: 'It is sunny and warm today.' });
    expect(promptNano).toHaveBeenCalledOnce();
  });

  it('escalates to the server when Nano replies ESCALATE', async () => {
    promptNano.mockResolvedValue('ESCALATE');
    const d = await resolveTurn('what is on my calendar tomorrow', base);
    // (this particular phrase also trips the action regex, but prove the Nano
    // escalate path too with a phrase that does not)
    expect(d).toMatchObject({ tier: TIER.SERVER });
  });

  it('escalates when Nano is unavailable', async () => {
    nanoAvailability.mockResolvedValue('no-api');
    const d = await resolveTurn('tell me something interesting', base);
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'nano-no-api' });
    expect(promptNano).not.toHaveBeenCalled();
  });

  it('escalates when Nano throws / times out', async () => {
    promptNano.mockRejectedValue(new Error('browser LLM timeout'));
    const d = await resolveTurn('tell me a joke', base);
    expect(d.tier).toBe(TIER.SERVER);
    expect(d.reason).toMatch(/nano-error/);
  });

  it('skips tier 1 when triggers are disabled', async () => {
    promptNano.mockResolvedValue('Sure.');
    const d = await resolveTurn('go to the pipeline', { ...base, fastPath: { ...base.fastPath, triggers: false } });
    // No nav match → falls to Nano (this phrase is not an action intent).
    expect(d.tier).toBe(TIER.NANO);
  });

  it('goes straight to the server when the browser tier is disabled and no trigger matches', async () => {
    const d = await resolveTurn('tell me a joke', { ...base, fastPath: { ...base.fastPath, browserLlm: false } });
    expect(d).toMatchObject({ tier: TIER.SERVER, reason: 'no-fast-tier' });
    expect(promptNano).not.toHaveBeenCalled();
  });
});
