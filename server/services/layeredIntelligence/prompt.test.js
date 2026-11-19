import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
} from './prompt.js';
import {
  plannedWorkUnavailable,
} from './sources.js';
import {
  PLANNED_WORK_GUIDANCE,
} from './constants.js';

describe('buildPrompt', () => {
  const app = { name: 'TestApp' };

  it('drops a blank cosMetrics document instead of rendering an empty block (#3085)', () => {
    // renderCosMetricsSource returns '' when it has neither task types nor delivery
    // data, and the hook assigns that straight onto sources — so the omission this
    // relies on happens HERE. A rendered `### cosMetrics` with nothing under it would
    // cost prompt budget and tell the reasoner nothing.
    const base = { app, config: { allowedScopes: ['app-improvement'], rules: '' } };
    expect(buildPrompt({ ...base, sources: { cosMetrics: '' } })).not.toContain('### cosMetrics');
    expect(buildPrompt({ ...base, sources: { cosMetrics: '{"delivery":{"totalApproved":3}}' } }))
      .toContain('### cosMetrics');
  });

  it('renders PortOS product metrics as a dedicated engagement signal', () => {
    const prompt = buildPrompt({
      app,
      isPortos: true,
      config: { allowedScopes: ['app-improvement'], rules: '' },
      sources: { productMetrics: '{"post":{"completedToday":false},"creativeCommissions":{"unreviewedRenders":2}}' },
    });
    expect(prompt).toContain('### productMetrics');
    expect(prompt).toContain('inactive daily POST');
    expect(prompt.match(/### productMetrics/g)).toHaveLength(1);
  });

  it('does not treat an omitted feature as an inactive improvement target', () => {
    const prompt = buildPrompt({
      app,
      isPortos: true,
      config: { allowedScopes: ['app-improvement'], rules: '' },
      sources: { productMetrics: '{"creativeCommissions":{"unreviewedRenders":2}}' },
    });

    expect(prompt).toContain('An omitted feature is not an inactive feature');
    expect(prompt).not.toContain('"post"');
  });

  it('injects the scope-awareness block only when present, under its own heading (#2760)', () => {
    const base = { app, isPortos: true, config: { allowedScopes: ['loop-meta'], rules: '' } };
    const without = buildPrompt(base);
    // Heading form: the always-on liPlaybook block legitimately references the block
    // id in prose, so assert the block itself (its `### ` heading) is absent, not the
    // bare token.
    expect(without).not.toContain('### liScopeAwareness');
    const withGuidance = buildPrompt({
      ...base,
      sources: { scopeGuidance: 'LOW-COMPLETION task types:\n- branch-reconcile: 0% completed over 4 runs' }
    });
    expect(withGuidance).toContain('### liScopeAwareness');
    expect(withGuidance).toContain('branch-reconcile: 0% completed over 4 runs');
    expect(withGuidance).toContain('completion rates for THIS install'); // honest framing (codex P1)
    // rendered under its dedicated heading, never as a generic "### scopeGuidance" dump
    expect(withGuidance).not.toContain('### scopeGuidance');
  });

  it('frames PortOS churn metrics as local evidence that needs a concrete fix', () => {
    const source = 'Instance-local CoS churn signals\n- self-improve:branch-reconcile: signal=short-lived-burst';
    const portos = buildPrompt({
      app,
      isPortos: true,
      config: { allowedScopes: ['loop-meta'], rules: '' },
      sources: { churnSignals: source }
    });
    expect(portos).toContain('### liChurnSignals');
    expect(portos).toContain('not an automatic filing instruction');
    expect(portos).toContain('concrete fix');
    expect(portos).not.toContain('### churnSignals');

    const managed = buildPrompt({
      app,
      isPortos: false,
      config: { allowedScopes: ['app-improvement'], rules: '' },
      sources: { churnSignals: source }
    });
    expect(managed).not.toContain('### liChurnSignals');
    expect(managed).not.toContain(source);
  });

  it('injects the per-proposal-domain execution block only when a report is passed (#2765)', () => {
    const base = { app, isPortos: true, config: { allowedScopes: ['loop-meta'], rules: '' } };
    expect(buildPrompt(base)).not.toContain('### liProposalExecution');
    const withExec = buildPrompt({
      ...base,
      proposalExecutionReport: 'HIGH-EXECUTION proposal domains — LI reliably implements its own proposals here (at or above 75%):\n- loop-meta: LI implemented 100% of its own loop-meta proposals successfully over 3 executed'
    });
    expect(withExec).toContain('### liProposalExecution');
    expect(withExec).toContain('loop-meta');
    expect(withExec).toContain('DIRECT record'); // framed as authoritative, not directional
  });

  it('injects the cross-reference block only when a report is passed (#2764 §3)', () => {
    const base = { app, isPortos: true, config: { allowedScopes: ['loop-meta'], rules: '' } };
    expect(buildPrompt(base)).not.toContain('### liCrossReference');
    const withXref = buildPrompt({
      ...base,
      crossReferenceReport: "Domains where LI PROPOSES well but EXECUTES poorly:\n- loop-meta: proposals merge at 50% (2/4) but hand-offs here fail on planning (3 of 4)"
    });
    expect(withXref).toContain('### liCrossReference');
    expect(withXref).toContain('hand-offs here fail on planning (3 of 4)');
  });

  it('suppresses the scope-awareness block on a managed (non-PortOS) app (#2760 codex P2)', () => {
    // Even if a stray scopeGuidance string reaches a managed app's sources, buildPrompt
    // must not render it — the rates are this install's own CoS history, meaningless
    // there. Defense-in-depth alongside gatherSources gating the derivation on isPortos.
    const out = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-improvement'], rules: '' },
      sources: { scopeGuidance: 'LOW-COMPLETION task types:\n- plan-task: 0% completed over 9 runs' }
    });
    expect(out).not.toContain('### liScopeAwareness');
    expect(out).not.toContain('plan-task: 0% completed over 9 runs');
  });

  it('only offers meta/self scopes on PortOS', () => {
    const nonPortos = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-improvement', 'app-data-gap', 'loop-meta'], rules: '' }
    });
    // Assert the scope is not OFFERED (absent from the allowed-scope bullet list,
    // rendered as `  - loop-meta`). The always-on liPlaybook block references loop-meta
    // by name in its prose — clearly marked "PortOS install only" — so a bare-token
    // check would spuriously fail; the offered-bullet form is the precise assertion.
    expect(nonPortos).not.toContain('  - loop-meta'); // gated out by isScopeAllowed
    expect(nonPortos).toContain('meta/self scopes are unavailable');

    const portos = buildPrompt({
      app, isPortos: true,
      config: { allowedScopes: ['app-improvement', 'loop-meta', 'portos-self'], rules: '' }
    });
    expect(portos).toContain('loop-meta');
    expect(portos).toContain('portos-self');
  });

  it('injects operator rules and open-issue slugs', () => {
    const out = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-improvement'], rules: 'prefer perf work' },
      openIssues: [{ number: 3, slug: 'existing-thing', title: 'Existing' }],
      sources: { goals: 'ship faster' }
    });
    expect(out).toContain('prefer perf work');
    expect(out).toContain('existing-thing');
    expect(out).toContain('ship faster');
    expect(out).toContain('JSON only');
    expect(out).toContain('"model": "light | medium | heavy | ultra"');
    expect(out).toContain('"effort": "low | medium | high | xhigh | max"');
    expect(out).toContain('"goodFirstIssue"');
    expect(out).toContain('"helpWanted"');
    expect(out).toContain('NOT a good first issue');
  });

  it('mentions the hand-off only when it is enabled', () => {
    const off = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } });
    expect(off).not.toContain('Hand-off:');
    const on = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '', handoff: { enabled: true } } });
    expect(on).toContain('Hand-off:');
    expect(on).toContain('"complexity":"trivial"');
  });

  it('injects the outcomes report + calibration guidance only when non-empty', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    const without = buildPrompt(base);
    expect(without).not.toContain('### liOutcomes');
    const withReport = buildPrompt({ ...base, outcomesReport: 'Past LI proposals (last 30 days):\n- Total filed: 3' });
    expect(withReport).toContain('### liOutcomes');
    expect(withReport).toContain('Total filed: 3');
    expect(withReport).toContain('calibrate your proposal');
  });

  it('injects the selfEval block only when non-empty (#2700)', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    expect(buildPrompt(base)).not.toContain('liSelfEval');
    expect(buildPrompt({ ...base, selfEvalReport: '   ' })).not.toContain('liSelfEval');
    const withReport = buildPrompt({ ...base, selfEvalReport: 'LI self-evaluation:\n- Reasoning confidence: low' });
    expect(withReport).toContain('### liSelfEval');
    expect(withReport).toContain('Reasoning confidence: low');
    expect(withReport).toContain('Filing nothing (proposal: null) is a legitimate');
  });

  it('injects delivery-throttle guidance under its own prompt heading (#3160)', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    expect(buildPrompt(base)).not.toContain('### liDeliveryThrottle');
    const withThrottle = buildPrompt({
      ...base,
      deliveryThrottleReport: 'LI proposal throttle: stopped — based on 0% delivery rate from 12 approved proposals. Return proposal: null.'
    });
    expect(withThrottle).toContain('### liDeliveryThrottle');
    expect(withThrottle).toContain('LI proposal throttle: stopped');
    expect(withThrottle).toContain('Return proposal: null');
  });

  it('renders selfEval and outcomes as independent blocks (either can stand alone)', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    const selfOnly = buildPrompt({ ...base, selfEvalReport: 'self-eval body' });
    expect(selfOnly).toContain('### liSelfEval');
    expect(selfOnly).not.toContain('### liOutcomes');
    const both = buildPrompt({ ...base, outcomesReport: 'outcomes body', selfEvalReport: 'self-eval body' });
    expect(both).toContain('### liOutcomes');
    expect(both).toContain('### liSelfEval');
  });

  it('frames the mission around the app\'s own goals and performance', () => {
    const out = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } });
    expect(out).toContain('its OWN goals');
  });

  it('uses read-only app context to distinguish healthy metrics from a visibility gap', () => {
    const out = buildPrompt({
      app,
      isPortos: false,
      config: { allowedScopes: ['app-improvement', 'app-data-gap'], rules: '' },
      sources: { appMetrics: 'Activation: unavailable' }
    });
    expect(out).toContain('inspect this repository READ-ONLY');
    expect(out).toContain('Do not edit files');
    expect(out).toContain('SPECIFIC visibility gap');
    expect(out).toContain('never file a generic "add more telemetry" issue');
    expect(out).toContain('Inconclusive metrics alone are not evidence that the app is healthy');
    expect(out).toContain('AT MOST ONE decision-complete tracker issue');
  });

  it('always injects the static proposal playbook block (#2763)', () => {
    // Unlike the data-driven blocks, the playbook is a-priori guidance that must be
    // present from run one — even with no sources, outcomes, or self-eval data.
    const bare = buildPrompt({ app, isPortos: true, config: { allowedScopes: ['loop-meta'], rules: '' } });
    expect(bare).toContain('### liPlaybook');
    expect(bare).toContain('# LI Proposal Playbook');
    // The five deliverables the issue calls for are all present in the rendered block.
    expect(bare).toContain('Scope Selection Guide');
    expect(bare).toContain('Success Pattern Catalog');
    expect(bare).toContain('Rejection Pattern Catalog');
    expect(bare).toContain('Task Type Selection Rules');
    expect(bare).toContain('Goal Alignment Check');
    // NOT_PLANNED = roadmap conflict is the headline rejection heuristic.
    expect(bare).toContain('NOT_PLANNED');
    expect(bare).toContain('Future-triggered refactor');
    expect(bare).toContain('third consumer appears');
    expect(bare).toContain('return `proposal: null`');
    // Rendered under its dedicated heading, never dumped as a generic source block.
    expect(bare).toContain('apply it as a hard constraint');
  });

  it('renders the playbook on managed (non-PortOS) apps too — the general rules are universal', () => {
    const managed = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } });
    expect(managed).toContain('### liPlaybook');
    expect(managed).toContain('Goal Alignment Check');
  });

  it('nudges a managed app with no own-performance metrics toward a METRICS.md data gap', () => {
    // No appMetrics source gathered → guidance to add a METRICS.md.
    const missing = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-data-gap'], rules: '' } });
    expect(missing).toContain('METRICS.md');
    // Present appMetrics → no add-a-METRICS.md nudge.
    const present = buildPrompt({
      app, isPortos: false, config: { allowedScopes: ['app-data-gap'], rules: '' },
      sources: { appMetrics: 'Weekly active users: up' }
    });
    expect(present).not.toContain('no METRICS.md');
  });

  it('does not nudge to add a METRICS.md when the appMetrics source is deliberately off', () => {
    // Source disabled → the file may exist but wasn't gathered; nudging to "add"
    // one would be misleading. No nudge despite empty gathered sources.
    const out = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-data-gap'], rules: '', sources: { appMetrics: false } }
    });
    expect(out).not.toContain('no METRICS.md');
  });

  it('does not nudge PortOS toward a METRICS.md (it measures itself via cosMetrics)', () => {
    const out = buildPrompt({ app, isPortos: true, config: { allowedScopes: ['portos-self'], rules: '' } });
    expect(out).not.toContain('no METRICS.md');
  });
});

describe('buildPrompt plannedWork block (#2698)', () => {
  const app = { name: 'App' };
  const config = { allowedScopes: ['app-improvement'], sources: {} };

  it('renders the block with the cross-reference guidance attached', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: '1 item(s):\n- #3 Ship X' } });
    expect(p).toContain('### plannedWork');
    expect(p).toContain('- #3 Ship X');
    expect(p).toContain(PLANNED_WORK_GUIDANCE);
    expect(p).toContain('DO NOT file — return proposal: null');
  });

  it('renders plannedWork ONCE — not also inside the generic source list', () => {
    const p = buildPrompt({ app, config, sources: { goals: 'be great', plannedWork: 'PLANNED BACKLOG' } });
    expect(p.match(/### plannedWork/g)).toHaveLength(1);
    expect(p).toContain('### goals');
  });

  it('puts the guidance AFTER the backlog it refers to', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: 'PLANNED BACKLOG' } });
    expect(p.indexOf('PLANNED BACKLOG')).toBeLessThan(p.indexOf(PLANNED_WORK_GUIDANCE));
  });

  it('still surfaces the "could not be read" sentinel to the reasoner', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: plannedWorkUnavailable('the gh issue list failed') } });
    expect(p).toContain('### plannedWork');
    expect(p).toContain('could NOT be read');
    expect(p).toContain(PLANNED_WORK_GUIDANCE);
  });

  it('omits the block entirely when the source produced nothing', () => {
    expect(buildPrompt({ app, config, sources: { goals: 'g' } })).not.toContain('### plannedWork');
    expect(buildPrompt({ app, config, sources: { plannedWork: '   ' } })).not.toContain('### plannedWork');
  });

  it('does not claim "no sources available" while rendering a populated plannedWork block', () => {
    // plannedWork is excluded from sourceBlocks so its guidance stays anchored —
    // the empty-sources fallback must not therefore contradict the block below it.
    const p = buildPrompt({ app, config, sources: { plannedWork: '1 item(s):\n- #3 Ship X' } });
    expect(p).toContain('- #3 Ship X');
    expect(p).toContain('(no other sources available');
    // Still says the plain thing when there is genuinely nothing at all.
    expect(buildPrompt({ app, config, sources: {} })).toContain('(no sources available');
  });
});
