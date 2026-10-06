import { describe, it, expect, vi } from 'vitest';
import { planMusicVideoPromotion } from './promotionPlan.js';
import { buildPromotionPlanPrompt, parsePromotionPlan, promotionPlanKey } from './promotionPlanText.js';

// 2026-10-06 11:00 in Los Angeles.
const NOW = Date.parse('2026-10-06T18:00:00.000Z');
const TZ = 'America/Los_Angeles';

const project = {
  id: 'mv-1234abcd-0000',
  name: 'Example Song',
  lyricCues: [{ text: 'This voice is not a person', startSec: 12 }, { text: 'Neither is yours', startSec: 15.5 }],
  publishKit: {
    posts: { x: { url: 'https://x.example.com/status/1' }, youtube: { url: 'https://video.example.com/watch?v=1' } },
    copy: { x: { hook: 'A song about minds.' } },
  },
};

const reply = JSON.stringify({ steps: [
  {
    title: 'Post the opening clip on X', day: 1, time: '09:30', priority: 'high',
    instructions: ['Cut 0:12–0:35 from the vertical cut.', 'Quote-post your video post with it.'],
    content: [{ label: 'X post', text: 'This voice is not a person.' }],
    links: [{ label: 'Your post', url: 'https://x.example.com/status/1' }, { label: 'Made up', url: 'https://invented.example.com' }],
  },
  { title: 'Answer replies', day: 0, time: '08:00', instructions: ['Reply to everyone who answered.'] },
  { title: 'No instructions', day: 2, time: '10:00', instructions: [] },
  { title: 'Far day', day: 99, time: '25:99', instructions: ['Check in.'] },
] });

const deps = () => ({
  getProject: vi.fn(async () => project),
  timezone: TZ,
  now: () => NOW,
  runner: {
    resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'p' }, selectedModel: 'm' })),
    runPromptThroughProvider: vi.fn(async () => ({ text: reply })),
  },
  humanActions: { scheduleHumanActionPlan: vi.fn(async (plan) => ({ planKey: plan.planKey, created: plan.steps, replaced: 0 })) },
});

describe('planMusicVideoPromotion', () => {
  it('turns one provider reply into a dated human action plan with only real links', async () => {
    const d = deps();
    await planMusicVideoPromotion(project.id, { goal: 'More followers', audience: 'People into AI consciousness', days: 7 }, d);

    const call = d.runner.runPromptThroughProvider.mock.calls[0][0];
    expect(call.source).toBe('music-video-promotion-plan');
    expect(call.prompt).toContain('People into AI consciousness');
    expect(call.prompt).toContain('- x: https://x.example.com/status/1');
    expect(call.prompt).toContain('0:12 This voice is not a person');

    const plan = d.humanActions.scheduleHumanActionPlan.mock.calls[0][0];
    expect(plan.planKey).toBe('promo-mv-1234abcd-0000');
    expect(plan.title).toBe('Promote "Example Song"');
    expect(plan.steps.map((s) => s.title)).toEqual(['Post the opening clip on X', 'Answer replies', 'Far day']);
    // Tomorrow 09:30 Los Angeles; an invented link is dropped.
    expect(plan.steps[0]).toMatchObject({ dueAt: '2026-10-07T16:30:00.000Z', priority: 'high', links: [{ label: 'Your post', url: 'https://x.example.com/status/1' }] });
    // Today 08:00 has already passed, so it is due in a few minutes rather than in the past.
    expect(plan.steps[1].dueAt).toBe('2026-10-06T18:05:00.000Z');
    // Day clamps to the last day of the window; a malformed time falls back to 18:00.
    expect(plan.steps[2].dueAt).toBe('2026-10-13T01:00:00.000Z');
  });

  it('reports an unusable reply instead of scheduling nothing', async () => {
    const d = deps();
    d.runner.runPromptThroughProvider.mockResolvedValue({ text: 'Sorry, no plan.' });
    await expect(planMusicVideoPromotion(project.id, {}, d)).rejects.toMatchObject({ code: 'PROMOTION_PLAN_UNPARSEABLE' });
    expect(d.humanActions.scheduleHumanActionPlan).not.toHaveBeenCalled();
  });
});

describe('promotion plan text', () => {
  it('keeps plan keys inside the tag limit', () => {
    expect(promotionPlanKey('mv-f507dc16-26a8-40c4-b905-c61536bbb3d6').length).toBeLessThanOrEqual(40);
    expect(promotionPlanKey('mv-f507dc16-26a8-40c4-b905-c61536bbb3d6')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('places a step across a DST change at its local time', () => {
    // 2026-11-01 is the US fall-back day; 18:00 local is 02:00Z the next day (PST, UTC-8).
    const reply = JSON.stringify({ steps: [{ title: 'Post', day: 0, time: '18:00', instructions: ['Post it.'] }] });
    const [step] = parsePromotionPlan(reply, { timezone: TZ, now: Date.parse('2026-11-01T17:00:00.000Z') });
    expect(step.dueAt).toBe('2026-11-02T02:00:00.000Z');
  });

  it('says nothing has been posted when nothing has', () => {
    expect(buildPromotionPlanPrompt({ name: 'X' }, { timezone: TZ })).toContain('Nothing has been posted yet.');
  });
});
