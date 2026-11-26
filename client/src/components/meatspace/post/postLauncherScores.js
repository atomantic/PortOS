export const scoreColorClass = (score) =>
  score >= 80 ? 'text-port-success' : score >= 50 ? 'text-port-warning' : 'text-port-error';

// Short "at a glance" summary chip per cognitive drill type, shown next to
// its label in the launcher sidebar. Pure — no closures over component state.
export function cognitiveSummary(type, cfg) {
  if (type === 'n-back') return `${cfg.n ?? 2}-back`;
  if (type === 'digit-span') return `${cfg.startLength ?? 3}–${cfg.maxLength ?? 8}`;
  if (type === 'schulte-table') return `${cfg.size ?? 5}×${cfg.size ?? 5}`;
  if (type === 'stroop') return `${cfg.incongruentPct ?? 75}% conflict`;
  if (type === 'mental-rotation') return `${cfg.optionCount ?? 4} options`;
  if (type === 'reaction-time') return `${cfg.count ?? 15} trials (${cfg.mode ?? 'simple'})`;
  if (type === 'task-switching') return `${cfg.ruleCount ?? 2} rules · ${cfg.switchRatePct ?? 50}% switch`;
  if (type === 'go-no-go') return `${cfg.noGoPct ?? 25}% no-go · ${cfg.lureSimilarity ?? 'low'} similarity`;
  if (type === 'flanker') return `${100 - (cfg.congruentPct ?? 60)}% conflict · strength ${cfg.flankerStrength ?? 2}`;
  return cfg.count ? `${cfg.count} trials` : '';
}
