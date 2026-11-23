/**
 * The moving-parts half of a Blender model's report: what describe() declared,
 * whether each control moves its part where it is told, whether any pose puts
 * one part through another, and whether the GLB poses the same. Pure; turns the
 * driver's facts (protocol.js) into `checks.motion` and findings.
 *
 * Values are 0-1 over `min`-`max`; the model is built at its defaults. A pose
 * the sweep's time did not reach is unmeasured, never clean.
 */
import { blenderModelActionSchema, blenderModelAllowContactSchema, blenderModelControlSchema } from '../../lib/blenderModelsValidation.js';

const LISTED = 50;
const OVERLAPS_LISTED = 50;
// Joint error as a fraction of its range, and off-axis or re-import error as a fraction of the model's diagonal.
const JOINT_TOLERANCE = 1e-3;
const PLACE_TOLERANCE = 1e-3;
const round = (value, digits = 4) => Number(value.toFixed(digits));
const listed = (items) => ({ subjects: items.slice(0, LISTED), ...(items.length > LISTED ? { more: items.length - LISTED } : {}) });
const pairKey = (a, b) => [a, b].sort().join('\n');
const nameOf = (entry) => (typeof entry?.id === 'string' && entry.id ? entry.id.slice(0, 64) : '(no id)');

/** The entries of a describe() list that parse, and `[name, reason]` for the rest. */
function parseEntries(list, schema) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const entry of list) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      invalid.push([nameOf(entry), `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`]);
    } else if (seen.has(parsed.data.id)) invalid.push([parsed.data.id, 'the id is used twice']);
    else {
      seen.add(parsed.data.id);
      valid.push(parsed.data);
    }
  }
  return { valid, invalid };
}

const addInvalid = (add, code, message, invalid) => {
  if (invalid.length) add('error', code, message, listed(invalid.map(([name, reason]) => `${name} (${reason})`)));
};

/** Dependencies that name no control, name themselves or run in a circle. */
function dependencyProblems(controls) {
  const byId = new Map(controls.map((control) => [control.id, control]));
  const reaches = (from, target, seen = new Set()) => (byId.get(from)?.dependsOn ?? []).some((dep) => {
    if (dep.control === target) return true;
    if (seen.has(dep.control)) return false;
    seen.add(dep.control);
    return reaches(dep.control, target, seen);
  });
  return controls.flatMap((control) => {
    const unknown = (control.dependsOn ?? []).filter((dep) => !byId.has(dep.control)).map((dep) => [control.id, `no control named ${dep.control}`]);
    return unknown.length ? unknown : reaches(control.id, control.id) ? [[control.id, 'depends on itself']] : [];
  });
}

/** What describe() declares to move, as findings and the entries worth checking further. */
function declaredMotion(facts, add) {
  const { controls, actions, allowContact } = facts.described;
  const partIds = new Set(facts.parts.map((part) => part.id));
  if (controls === undefined) add('error', 'controls-invalid', 'controls must be a list of at most 16 KiB');
  if (actions === undefined) add('error', 'actions-invalid', 'actions must be a list of at most 16 KiB');
  if (allowContact === undefined) add('error', 'allow-contact-invalid', 'allowContact must be a list of part id pairs of at most 16 KiB');
  const parsed = parseEntries(controls ?? [], blenderModelControlSchema);
  const unknownPart = parsed.valid.filter((control) => !partIds.has(control.partId)).map((control) => [control.id, `no part named ${control.partId}`]);
  addInvalid(add, 'control-invalid', 'A control is not one a build can rig', [...parsed.invalid, ...unknownPart]);
  addInvalid(add, 'control-dependency-invalid', 'A control depends on something that cannot hold', dependencyProblems(parsed.valid));
  const declaredActions = parseEntries(actions ?? [], blenderModelActionSchema);
  addInvalid(add, 'action-invalid', 'An action is not one a build can evaluate', declaredActions.invalid);
  if (declaredActions.valid.length && controls !== undefined && !controls?.length) add('error', 'actions-without-controls', 'actions pose controls, and describe() declares none');

  const pairs = [];
  const badPairs = [];
  for (const entry of allowContact ?? []) {
    const pair = blenderModelAllowContactSchema.safeParse(entry);
    if (pair.success && pair.data.every((id) => partIds.has(id))) pairs.push(pair.data);
    else badPairs.push(JSON.stringify(entry)?.slice(0, 120) ?? '(empty)');
  }
  if (badPairs.length) add('warning', 'allow-contact-unknown', 'allowContact entries must each name two declared parts', listed(badPairs));
  return { controls: parsed.valid.filter((control) => partIds.has(control.partId)), actions: declaredActions.valid, allowed: pairs };
}

const diagonalOf = (scene) => (scene?.min && scene?.max ? Math.hypot(...scene.max.map((high, axis) => high - scene.min[axis])) : 0);

/** Whether each control's action clamps outside 0-1 and puts its part where it is told, in Blender and in the GLB. */
function controlChecks(controls, facts, add) {
  const of = (event) => new Map(facts.motion.filter((entry) => entry.event === event).map((entry) => [entry.id, entry]));
  const rigged = of('control');
  const skipped = of('control-skipped');
  const reimported = of('reimport-control');
  const placeTolerance = Math.max(diagonalOf(facts.scene) * PLACE_TOLERANCE, 1e-6);
  const unrigged = [];
  const unclamped = [];
  const mismatched = [];
  const glb = [];
  const checked = [];
  for (const control of controls) {
    const fact = rigged.get(control.id);
    if (!fact) {
      unrigged.push([control.id, skipped.get(control.id)?.reason ?? 'the build did not rig it']);
      continue;
    }
    const span = control.max - control.min;
    const off = (probe) => [probe.expected, probe.measured, probe.drift].some((value) => value === null)
      || Math.abs(probe.measured - probe.expected) > span * JOINT_TOLERANCE || probe.drift > placeTolerance;
    const at = (command) => fact.probes.filter((probe) => probe.command === command);
    const beyond = fact.probes.filter((probe) => probe.command < 0 || probe.command > 1);
    const within = fact.probes.filter((probe) => probe.command >= 0 && probe.command <= 1);
    const clamps = [-0.3, 1.3].every((command) => at(command).length === 1) && !beyond.some(off);
    const follows = [0, 0.5, 1].every((command) => at(command).length === 1) && !within.some(off);
    if (!clamps) unclamped.push(control.id);
    if (!follows) mismatched.push(control.id);
    const after = reimported.get(control.id);
    const glbError = after?.found ? after.error : null;
    if (glbError === null || glbError > placeTolerance) glb.push(control.id);
    checked.push({
      ...control, dependsOn: control.dependsOn ?? [], default01: round((control.default - control.min) / span, 6),
      parts: fact.parts, probes: fact.probes, clamps, follows, reimportError: glbError,
    });
  }
  addInvalid(add, 'control-not-rigged', 'A declared control was not rigged', unrigged);
  if (unclamped.length) add('error', 'control-clamp', 'A control\'s action moves its part past its range outside 0-1', listed(unclamped));
  if (mismatched.length) add('error', 'control-mismatch', 'A control\'s part is not where its value says', listed(mismatched));
  if (glb.length) add('error', 'reimport-control', 'The re-imported GLB does not move a control\'s part to the same pose', listed(glb));
  return checked;
}

function actionChecks(actions, facts, add) {
  const evaluated = new Map(facts.motion.filter((entry) => entry.event === 'action').map((entry) => [entry.id, entry]));
  const checked = actions.map((action) => {
    const fact = evaluated.get(action.id);
    return { id: action.id, label: action.label ?? action.id, seconds: action.seconds, frames: fact?.frames ?? 0, error: fact ? fact.error : 'the build did not evaluate it', unmetAt: fact?.unmetAt ?? null, unmet: fact?.unmet ?? [] };
  });
  addInvalid(add, 'action-failed', 'pose(ctx, action, t) could not be evaluated', checked.filter((action) => action.error).map((action) => [action.id, action.error]));
  const unmet = checked.filter((action) => action.unmet.length);
  if (unmet.length) {
    add('warning', 'action-dependency-unmet', 'An action moves a control while what it depends on is not met',
      listed(unmet.map((action) => `${action.id} (${action.unmet.join(', ')} at t ${round(action.unmetAt ?? 0, 3)})`)));
  }
  return checked;
}

const scopeLabel = ({ kind, ids }) => (kind === 'action' ? `action ${ids[0]}` : ids.join(' + '));
const poseLabel = (values, controls) => controls.filter((control) => values[control.id] !== undefined && Math.abs(values[control.id] - control.default01) > 1e-4)
  .map((control) => `${control.label} ${round(values[control.id], 3)}`).join(', ') || 'every control at its default';

/** One entry per pair of parts that meet: where first, and every scope it happened in. */
function overlapPairs(facts) {
  const pairs = new Map();
  for (const event of facts.motion) {
    if (event.event !== 'sweep-overlap') continue;
    const key = pairKey(event.a, event.b);
    const entry = pairs.get(key) ?? { parts: [event.a, event.b], first: event.values, where: [] };
    entry.where.push({ kind: event.kind, ids: event.ids, poses: event.count, t: event.t, first: event.values });
    pairs.set(key, entry);
  }
  return pairs;
}

/** What the sweep planned and did not measure. */
function unmeasuredScopes(controls, actions, facts) {
  const scopes = facts.motion.filter((event) => event.event === 'sweep-scope');
  const seen = new Set(scopes.map(scopeLabel));
  const expected = [...controls.map(({ id }) => ({ kind: 'control', ids: [id] })), ...actions.map(({ id }) => ({ kind: 'action', ids: [id] }))];
  return [
    ...scopes.filter((scope) => scope.planned === null || scope.measured === null || scope.measured < scope.planned)
      .map((scope) => ({ what: scopeLabel(scope), planned: scope.planned, measured: scope.measured })),
    ...expected.filter((scope) => !seen.has(scopeLabel(scope))).map((scope) => ({ what: scopeLabel(scope), planned: null, measured: 0 })),
    ...(facts.sweep?.empty ?? []).map((name) => ({ what: `part ${name} (no faces)`, planned: null, measured: 0 })),
  ];
}

function sweepChecks(controls, declared, facts, add) {
  const pairs = overlapPairs(facts);
  const allowedKeys = new Set(declared.allowed.map(([a, b]) => pairKey(a, b)));
  const rest = facts.motion.filter((event) => event.event === 'sweep-rest').map((event) => [event.a, event.b]);
  const overlaps = [...pairs].filter(([key]) => !allowedKeys.has(key)).map(([, entry]) => entry);
  const allowed = declared.allowed.map(([a, b]) => ({ parts: [a, b], met: pairs.has(pairKey(a, b)) || rest.some(([c, d]) => pairKey(c, d) === pairKey(a, b)) }));
  const stuck = facts.motion.filter((event) => event.event === 'sweep-scope' && event.kind === 'control' && event.blocked > 0).map((event) => event.ids[0]);
  if (stuck.length) add('error', 'control-unreachable', 'A control\'s dependencies contradict each other, so it cannot reach part of its range', listed(stuck));
  const unmeasured = unmeasuredScopes(controls, declared.actions, facts);

  for (const entry of overlaps.slice(0, OVERLAPS_LISTED)) {
    add('error', 'sweep-overlap', `${entry.parts.join(' and ')} pass through each other, first with ${poseLabel(entry.first, controls)}`, {
      subjects: entry.parts, pose: entry.first, values: { where: entry.where },
    });
  }
  const unlisted = Math.max(0, overlaps.length - OVERLAPS_LISTED);
  const found = facts.motion.filter((event) => event.event === 'sweep-overlap').length;
  if (unlisted || (facts.sweep?.overlaps ?? 0) > found) {
    add('error', 'sweep-overlap-more', 'More overlaps were found than are listed here', { values: { pairsNotListed: unlisted, found: facts.sweep?.overlaps ?? found } });
  }
  if (unmeasured.length) {
    add('warning', 'sweep-unmeasured', `Not every pose was checked for parts passing through each other${facts.sweep?.budgetSec != null ? ` (a build looks for ${facts.sweep.budgetSec} seconds)` : ''}`, {
      ...listed(unmeasured.map(({ what, planned, measured }) => (planned === null ? what : `${what} (${measured ?? 0} of ${planned} poses)`))), values: { unmeasured },
    });
  }
  if (allowed.length) {
    add('note', 'sweep-allowed-contact', 'allowContact lets these parts touch, so their overlaps are not errors', listed(allowed.map(({ parts, met }) => `${parts.join(' and ')}${met ? '' : ' (never met)'}`)));
  }
  if (rest.length) {
    add('note', 'sweep-rest-overlap', 'These parts already overlap as built, so their movement against each other was not checked', {
      ...listed(rest.map((pair) => pair.join(' and '))), values: { pairs: facts.sweep?.restPairs ?? rest.length },
    });
  }
  return {
    poses: facts.sweep?.poses ?? 0, parts: facts.sweep?.parts ?? null, budgetSec: facts.sweep?.budgetSec ?? null, sec: facts.sweep?.sec ?? null,
    scopes: facts.motion.filter((event) => event.event === 'sweep-scope').map(({ kind, ids, planned, measured, blocked: unreachable }) => ({ kind, ids, planned, measured, unreachable })),
    overlaps: overlaps.slice(0, OVERLAPS_LISTED), allowed, rest, unmeasured,
    clean: overlaps.length === 0 && !unlisted && unmeasured.length === 0 && facts.sweep !== null,
  };
}

/** `checks.motion`, or null for a model that declares nothing to move. */
export function motionChecks(facts, add) {
  if (!facts.described) return null;
  const declared = declaredMotion(facts, add);
  if (!declared.controls.length) return null;
  const controls = controlChecks(declared.controls, facts, add);
  if (!controls.length) return null;
  return { controls, actions: actionChecks(declared.actions, facts, add), sweep: sweepChecks(controls, declared, facts, add) };
}
