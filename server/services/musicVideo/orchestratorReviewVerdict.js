/** Parse checkpoint verdicts and the bounded edits a Music Video reviewer can return. */
import { ServerError } from '../../lib/errorHandler.js';
import { extractJson } from '../../lib/jsonExtract.js';
import { SUNO_LIMITS } from '../../lib/musicVideo/musicVideoAutonomous.js';
import { isStr, trimTo } from '../../lib/textUtils.js';

const NOTES_MAX = 1500;
const CHANGE_MAX = 2000;
const CHANGES_MAX = 12;
// The art-direction fields a reviewer may rewrite (productionReview draft keys).
export const ORCHESTRATOR_ART_FIELDS = Object.freeze(['cast', 'environments', 'visualLanguage', 'motionLanguage']);
const STORYBOARD_FILL_FIELDS = ['action', 'staging', 'camera', 'transition'];

const score = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : null;
};
const text = (v, max) => (isStr(v) ? trimTo(v.replace(/\r\n?/g, '\n'), max) : '');

/**
 * Parse a reviewer answer into `{ verdict, score, notes, ...fields }`. Each
 * checkpoint names the verdicts it accepts; a revise with nothing to apply
 * stays a revise (the caller decides what an empty revision means).
 */
export function parseOrchestratorVerdict(raw, checkpoint) {
  const allowed = checkpoint === 'song' ? ['approve', 'retake'] : ['approve', 'revise'];
  const { value: parsed } = extractJson(String(raw || ''), { shapePredicate: (o) => o && typeof o === 'object' && !Array.isArray(o) && isStr(o.verdict) });
  const verdict = isStr(parsed?.verdict) ? parsed.verdict.trim().toLowerCase() : null;
  if (!allowed.includes(verdict)) {
    throw new ServerError(`The orchestrator returned no usable ${checkpoint} verdict`, { status: 502, code: 'ORCHESTRATOR_BAD_VERDICT' });
  }
  const out = { verdict, score: score(parsed.score), notes: text(parsed.notes, NOTES_MAX) };
  const changes = Array.isArray(parsed.changes) ? parsed.changes.slice(0, CHANGES_MAX) : [];
  switch (checkpoint) {
    case 'lyrics':
      return { ...out, lyrics: verdict === 'revise' ? text(parsed.lyrics, SUNO_LIMITS.lyrics) : '' };
    case 'style':
      return { ...out,
        sunoStyle: text(parsed.sunoStyle, SUNO_LIMITS.style),
        conceptStyle: text(parsed.conceptStyle, 2000),
        lookPrompt: text(parsed.lookPrompt, 4000) };
    case 'art':
      return { ...out, changes: changes
        .filter((c) => ORCHESTRATOR_ART_FIELDS.includes(c?.field) && text(c.text, CHANGE_MAX))
        .map((c) => ({ field: c.field, text: text(c.text, 8000) })) };
    case 'storyboard':
      return { ...out,
        changes: changes.filter((c) => text(c?.sceneId, 200) && text(c?.text, CHANGE_MAX))
          .map((c) => ({ sceneId: text(c.sceneId, 200), text: text(c.text, CHANGE_MAX) })),
        fill: (Array.isArray(parsed.fill) ? parsed.fill : []).filter((f) => text(f?.sceneId, 200)).slice(0, 200)
          .map((f) => ({ sceneId: text(f.sceneId, 200),
            ...Object.fromEntries(STORYBOARD_FILL_FIELDS.map((k) => [k, text(f[k], CHANGE_MAX)]).filter(([, v]) => v)) })) };
    case 'stills':
      return { ...out, issues: (Array.isArray(parsed.issues) ? parsed.issues : []).slice(0, CHANGES_MAX)
        .filter((i) => text(i?.sceneId, 200) && text(i?.text, CHANGE_MAX))
        .map((i) => ({ sceneId: text(i.sceneId, 200), text: text(i.text, 500) })) };
    case 'final':
      return { ...out, issues: (Array.isArray(parsed.issues) ? parsed.issues : []).slice(0, CHANGES_MAX)
        .filter((i) => text(i?.text, 500))
        .map((i) => ({ atSec: Number.isFinite(Number(i.atSec)) ? Math.max(0, Number(i.atSec)) : null, text: text(i.text, 500) })) };
    default:
      return out;
  }
}
