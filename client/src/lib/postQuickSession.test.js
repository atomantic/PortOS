import { describe, expect, it } from 'vitest';
import {
  QUICK_DURATION_MINUTES,
  buildQuickDrillConfig,
  composeQuickSession,
  deriveQuickObservedDurations,
  estimateQuickDrillDurationSec,
  normalizeQuickDurationMinutes,
} from './postQuickSession.js';

describe('postQuickSession', () => {
  it('accepts only the persisted Quick duration presets', () => {
    expect(QUICK_DURATION_MINUTES).toEqual([3, 5, 10, 15]);
    expect(normalizeQuickDurationMinutes(10)).toBe(10);
    expect(normalizeQuickDurationMinutes('15')).toBe(15);
    expect(normalizeQuickDurationMinutes(7)).toBe(5);
  });

  it('keeps new-install estimates stable until three local observations exist', () => {
    const candidate = { type: 'multiplication', source: 'math', quickConfig: { count: 5, steps: 2 } };
    const defaultEstimate = estimateQuickDrillDurationSec(candidate, { multiplication: [2, 4] });
    const refinedEstimate = estimateQuickDrillDurationSec(candidate, { multiplication: [20, 40, 60] });
    expect(defaultEstimate).toBe(30);
    expect(refinedEstimate).toBe(40);
  });

  it('derives task observations without copying prompts or other session content', () => {
    expect(deriveQuickObservedDurations([
      { tasks: [{ type: 'multiplication', totalMs: 12000, questions: [{ prompt: 'private' }] }] },
      { tasks: [{ type: 'multiplication', totalMs: 18000 }] },
    ])).toEqual({ multiplication: [12, 18] });
  });

  it('composes deterministically, prioritizing the recommendation and due reviews', () => {
    const input = {
      durationMinutes: 3,
      domainEntries: [
        { domain: 'math', drills: [{ type: 'multiplication', source: 'math', cfg: { count: 5, steps: 2 } }, { type: 'powers', source: 'math', cfg: { count: 5 } }] },
        { domain: 'cognitive', drills: [{ type: 'n-back', source: 'cognitive', cfg: { length: 20 } }] },
        { domain: 'memory', drills: [{ type: 'memory-sequence', source: 'memory', cfg: { count: 3 }, memoryItemId: 'example-memory' }] },
      ],
      recommendation: { drillType: 'powers' },
      reviewReps: [{ type: 'multiplication', module: 'mental-math', domain: 'math', label: 'Due multiplication', config: { count: 3 } }],
    };
    const first = composeQuickSession(input);
    const second = composeQuickSession(input);

    expect(first).toEqual(second);
    expect(first.selected[0].type).toBe('powers');
    expect(first.selected[1].kind).toBe('review');
    expect(first.selected.some(candidate => candidate.domain === 'cognitive')).toBe(true);
    expect(first.estimatedDurationSec).toBeLessThanOrEqual(first.budgetSec);
  });

  it('counts a long maintenance rep against the budget and explains omissions', () => {
    const plan = composeQuickSession({
      durationMinutes: 3,
      domainEntries: [
        { domain: 'math', drills: [{ type: 'multiplication', source: 'math', cfg: { count: 5, steps: 2 } }] },
        { domain: 'cognitive', drills: [{ type: 'n-back', source: 'cognitive', cfg: { length: 20 } }] },
      ],
      reviewReps: [{ type: 'powers', module: 'mental-math', label: 'Due powers', config: { count: 5 } }],
      observedDurations: { powers: [190, 190, 190] },
    });

    expect(plan.selected.map(candidate => candidate.type)).toEqual(['powers']);
    expect(plan.omittedDomains).toEqual(['math', 'cognitive']);
    expect(plan.withinBudget).toBe(true);
  });

  it('builds the same short config shapes as the launcher', () => {
    expect(buildQuickDrillConfig({
      type: 'memory-sequence', source: 'memory', cfg: { count: 8 }, memoryItemId: 'example-memory',
    })).toEqual({ count: 3, memoryItemId: 'example-memory' });
    expect(buildQuickDrillConfig({
      type: 'multiplication', source: 'math', cfg: { count: 8, steps: 4, maxDigits: 2 },
    })).toMatchObject({ count: 5, steps: 4, maxDigits: 2 });
  });

  // Issue #5319: a domain with several enabled drills used to resolve to
  // registry-order list[0] forever, so Quick Session served the same drill every
  // day. Recency + a local-day rotation replace that fixed order — without
  // introducing randomness, which would break re-requesting the same plan.
  describe("recent-practice rotation (issue #5319)", () => {
    const twoMathDrills = [
      { domain: "math", drills: [
        { type: "multiplication", source: "math", cfg: { count: 5, steps: 2 } },
        { type: "powers", source: "math", cfg: { count: 5 } },
      ] },
    ];
    const pickedMathType = (recentPractice, recommendation = null) => composeQuickSession({
      durationMinutes: 15, domainEntries: twoMathDrills, recommendation, recentPractice,
    }).selected.find(candidate => candidate.domain === "math").type;

    it("skips the registry-first drill once it was practiced in the window", () => {
      expect(pickedMathType(null)).toBe("multiplication");
      expect(pickedMathType({ dayKey: "2026-03-02", drillTypes: ["multiplication"] })).toBe("powers");
    });

    it("drops the recommendation preference only when the recommended drill is itself recent", () => {
      const rec = { drillType: "powers" };
      expect(pickedMathType({ dayKey: "2026-03-02", drillTypes: [] }, rec)).toBe("powers");
      expect(pickedMathType({ dayKey: "2026-03-02", drillTypes: ["powers"] }, rec)).toBe("multiplication");
    });

    it("rotates equally-eligible drills across days and repeats within one day", () => {
      const heads = ["2026-03-01", "2026-03-02"].map(dayKey => pickedMathType({ dayKey, drillTypes: [] }));
      expect(new Set(heads).size).toBe(2);
      const plan = { dayKey: "2026-03-02", drillTypes: [] };
      expect(pickedMathType(plan)).toBe(pickedMathType(plan));
    });

    it("keeps the only candidate in a domain even when it is recent", () => {
      const plan = composeQuickSession({
        durationMinutes: 15,
        domainEntries: [{ domain: "cognitive", drills: [{ type: "n-back", source: "cognitive", cfg: { length: 20 } }] }],
        recentPractice: { dayKey: "2026-03-02", drillTypes: ["n-back"] },
      });
      expect(plan.selected.map(c => c.type)).toEqual(["n-back"]);
    });

    it("identifies a memory drill by its ITEM, so practicing one item does not sink the others", () => {
      const memoryDomain = [{ domain: "memory", drills: [
        { type: "memory-sequence", source: "memory", cfg: { count: 3 }, memoryItemId: "elements-song" },
        { type: "memory-fill-blank", source: "memory", cfg: { count: 3 }, memoryItemId: "example-poem" },
      ] }];
      const picked = composeQuickSession({
        durationMinutes: 15,
        domainEntries: memoryDomain,
        // Elements practiced; the sibling ITEM must stay eligible even though
        // the type-level signal would otherwise mark the whole domain recent.
        recentPractice: { dayKey: "2026-03-02", drillTypes: ["memory-sequence"], memoryItemIds: ["elements-song"] },
      }).selected.find(candidate => candidate.domain === "memory");
      expect(picked.type).toBe("memory-fill-blank");
    });
  });
});
// @vitest-environment node
