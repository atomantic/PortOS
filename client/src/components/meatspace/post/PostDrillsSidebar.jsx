import { Link } from 'react-router';
import { Brain } from 'lucide-react';
import { DRILL_LABELS } from './constants';
import BrowseCatalogLink from './BrowseCatalogLink';
import { CognitiveDrillHowItWorksButton } from './CognitiveDrillTutorial';
import { cognitiveSummary } from './postLauncherScores';

export default function PostDrillsSidebar({
  drillCatalog, providers, recentSessions, setHowItWorksType,
}) {
  const {
    enabledMathDrills, enabledLlmDrills, enabledCognitiveDrills, llmProviderId, moduleAllowed, hasAnyDrills,
  } = drillCatalog;
  const lastThree = (recentSessions || []).slice(-3).reverse();
  return (
    <div className="space-y-6 min-w-0">
      {/* Mental Math Drills */}
      {enabledMathDrills.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Mental Math</h3>
          <div className="space-y-2">
            {enabledMathDrills.map(([type, cfg]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-white">{DRILL_LABELS[type] || type}</span>
                <span className="text-gray-500">
                  {cfg.steps ? `${cfg.steps} steps` : cfg.count ? `${cfg.count} questions` : ''}
                  {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LLM Drills */}
      {enabledLlmDrills.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={14} className="text-port-accent-2" />
            <h3 className="text-sm font-medium text-gray-400">Wit & Memory</h3>
            {(llmProviderId || providers.length > 0) && (
              <span className="text-xs text-gray-600 ml-auto">
                {llmProviderId || 'system default'}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {enabledLlmDrills.map(([type, cfg]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-white">{DRILL_LABELS[type] || type}</span>
                <span className="text-gray-500">
                  {cfg.count ? `${cfg.count} prompts` : ''}
                  {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                </span>
              </div>
            ))}
          </div>
          {/* These are enabled but not in a default composed session — LLM
              drills stay opt-in for provider-cost consent (issue #2100). */}
          {!moduleAllowed('llm') && (
            <p className="mt-3 text-xs text-gray-500">
              Not in Full POST / Quick sessions. Add “Wit &amp; Memory (AI)” under Config → Session Composition to include them.
            </p>
          )}
        </div>
      )}

      {/* Cognitive Drills (deterministic — no provider) */}
      {enabledCognitiveDrills.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={14} className="text-rose-400" />
            <h3 className="text-sm font-medium text-gray-400">Cognitive</h3>
          </div>
          <div className="space-y-2">
            {enabledCognitiveDrills.map(([type, cfg]) => (
              <div key={type} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-white truncate">{DRILL_LABELS[type] || type}</span>
                  {/* Re-entry to the how-to card the first-run gate showed once
                      and never again (issue #4732). Opens a preview with no
                      runner behind it, so no timer starts and nothing is scored. */}
                  <CognitiveDrillHowItWorksButton type={type} onClick={() => setHowItWorksType(type)} compact />
                </span>
                <span className="text-gray-500 text-right">
                  {cognitiveSummary(type, cfg)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* These cards list only the drills you have switched ON, so with
          nothing enabled the sidebar would be blank and POST would look
          empty. Point at the catalog and the plan, not just "configure". */}
      {!hasAnyDrills && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
          <p className="text-gray-500 text-sm">No drills enabled yet.</p>
          <BrowseCatalogLink />
          <p className="text-xs text-gray-500">
            Then switch on what you want in{' '}
            <Link to="/post/plan" className="text-port-accent hover:underline">Practice Plan</Link>.
          </p>
        </div>
      )}

      {hasAnyDrills && <BrowseCatalogLink />}

      {/* Recent Scores */}
      {lastThree.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Sessions</h3>
          <div className="space-y-2">
            {lastThree.map(s => (
              <div key={s.id} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{s.date}</span>
                <span className={`font-mono font-medium ${
                  s.score >= 80 ? 'text-port-success' :
                  s.score >= 50 ? 'text-port-warning' :
                  'text-port-error'
                }`}>
                  {s.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
