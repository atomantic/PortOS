import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, TrendingUp, Layers, BarChart3 } from 'lucide-react';

function CollapsibleSection({ title, icon: Icon, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-port-bg transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={14} />
        <span>{title}</span>
      </button>
      {open && <div className="px-3 pb-3 text-sm">{children}</div>}
    </div>
  );
}

export default function InterviewAnalysisCard({ analysisResult }) {
  if (!analysisResult) return null;

  const { traitsUpdated, documentsCreated, documentsUpdated, newDimensions, confidenceDelta, rawAnalysis } = analysisResult;

  const traitCount = Object.keys(traitsUpdated || {}).length;
  const docsCreatedCount = (documentsCreated || []).length;
  const docsUpdatedCount = (documentsUpdated || []).length;
  const dimensionCount = (newDimensions || []).length;

  return (
    <div className="mt-2 space-y-2">
      {/* Summary badges */}
      <div className="flex flex-wrap gap-2">
        {traitCount > 0 && (
          <span className="px-2 py-1 text-xs rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
            {traitCount} trait categories updated
          </span>
        )}
        {docsCreatedCount > 0 && (
          <span className="px-2 py-1 text-xs rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
            {docsCreatedCount} docs created
          </span>
        )}
        {docsUpdatedCount > 0 && (
          <span className="px-2 py-1 text-xs rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
            {docsUpdatedCount} docs updated
          </span>
        )}
        {dimensionCount > 0 && (
          <span className="px-2 py-1 text-xs rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30">
            {dimensionCount} new dimensions
          </span>
        )}
        {confidenceDelta && confidenceDelta.after !== confidenceDelta.before && (
          <span className="px-2 py-1 text-xs rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            Confidence: {Math.round(confidenceDelta.before * 100)}% → {Math.round(confidenceDelta.after * 100)}%
          </span>
        )}
      </div>

      {/* Collapsible sections */}
      <div className="space-y-1">
        {traitCount > 0 && (
          <CollapsibleSection title="Trait Updates" icon={BarChart3}>
            <div className="space-y-2">
              {traitsUpdated.bigFive && (
                <div>
                  <p className="text-gray-400 mb-1">Big Five:</p>
                  <div className="grid grid-cols-5 gap-2">
                    {Object.entries(traitsUpdated.bigFive).filter(([k]) => k !== 'notes').map(([k, v]) => (
                      <div key={k} className="text-center">
                        <div className="text-xs text-gray-500">{k}</div>
                        <div className="text-white font-medium">{typeof v === 'number' ? v.toFixed(2) : v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {traitsUpdated.valuesHierarchy && (
                <div>
                  <p className="text-gray-400 mb-1">Values:</p>
                  <div className="flex flex-wrap gap-1">
                    {traitsUpdated.valuesHierarchy.map((v, i) => (
                      <span key={i} className="px-2 py-0.5 text-xs bg-port-bg rounded text-gray-300">
                        {v.value} ({v.priority})
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {traitsUpdated.communicationProfile && (
                <div>
                  <p className="text-gray-400 mb-1">Communication:</p>
                  <div className="text-xs text-gray-300 space-y-0.5">
                    {traitsUpdated.communicationProfile.formality !== undefined && (
                      <div>Formality: {traitsUpdated.communicationProfile.formality}/10</div>
                    )}
                    {traitsUpdated.communicationProfile.verbosity !== undefined && (
                      <div>Verbosity: {traitsUpdated.communicationProfile.verbosity}/10</div>
                    )}
                    {traitsUpdated.communicationProfile.preferredTone && (
                      <div>Tone: {traitsUpdated.communicationProfile.preferredTone}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {dimensionCount > 0 && (
          <CollapsibleSection title="New Dimensions" icon={Layers}>
            <div className="space-y-2">
              {newDimensions.map((dim, i) => (
                <div key={i} className="bg-port-bg rounded p-2">
                  <div className="font-medium text-purple-400 text-xs mb-1">{dim.name}</div>
                  <div className="space-y-1">
                    {dim.traits.map((t, j) => (
                      <div key={j} className="text-xs text-gray-300">
                        <span className="text-white">{t.trait}:</span> {t.expression}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {(docsCreatedCount > 0 || docsUpdatedCount > 0) && (
          <CollapsibleSection title="Document Changes" icon={FileText}>
            <div className="space-y-1">
              {(documentsCreated || []).map((f, i) => (
                <div key={`c-${i}`} className="text-xs text-green-400">+ {f}</div>
              ))}
              {(documentsUpdated || []).map((f, i) => (
                <div key={`u-${i}`} className="text-xs text-yellow-400">~ {f}</div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {rawAnalysis && (
          <CollapsibleSection title="Analysis Summary" icon={TrendingUp} defaultOpen>
            <p className="text-xs text-gray-300 whitespace-pre-wrap">{rawAnalysis}</p>
          </CollapsibleSection>
        )}
      </div>
    </div>
  );
}
