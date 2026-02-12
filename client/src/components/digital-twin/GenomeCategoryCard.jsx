import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

const STATUS_DOT = {
  beneficial: 'bg-green-400',
  typical: 'bg-blue-400',
  concern: 'bg-yellow-400',
  major_concern: 'bg-red-400',
  not_found: 'bg-gray-500'
};

const STATUS_LABEL = {
  beneficial: 'Beneficial',
  typical: 'Typical',
  concern: 'Concern',
  major_concern: 'Major Concern',
  not_found: 'Not Found'
};

const STATUS_BADGE = {
  beneficial: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/30' },
  typical: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' },
  concern: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  major_concern: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30' },
  not_found: { bg: 'bg-gray-500/20', text: 'text-gray-400', border: 'border-gray-500/30' }
};

const COLOR_MAP = {
  purple: 'border-purple-500/30 bg-purple-500/5',
  rose: 'border-rose-500/30 bg-rose-500/5',
  red: 'border-red-500/30 bg-red-500/5',
  blue: 'border-blue-500/30 bg-blue-500/5',
  emerald: 'border-emerald-500/30 bg-emerald-500/5',
  amber: 'border-amber-500/30 bg-amber-500/5',
  green: 'border-green-500/30 bg-green-500/5',
  orange: 'border-orange-500/30 bg-orange-500/5',
  indigo: 'border-indigo-500/30 bg-indigo-500/5',
  cyan: 'border-cyan-500/30 bg-cyan-500/5',
  violet: 'border-violet-500/30 bg-violet-500/5',
  sky: 'border-sky-500/30 bg-sky-500/5',
  yellow: 'border-yellow-500/30 bg-yellow-500/5'
};

export default function GenomeCategoryCard({ category, label, emoji, color, markers, onEditNotes, onDeleteMarker }) {
  const [expanded, setExpanded] = useState(true);
  const [expandedMarker, setExpandedMarker] = useState(null);

  const statusSummary = markers.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  const headerColor = COLOR_MAP[color] || COLOR_MAP.blue;

  return (
    <div className={`border rounded-lg ${headerColor}`}>
      {/* Category header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-white/5 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none">{emoji}</span>
          <span className="font-medium text-white text-sm">{label}</span>
          <span className="text-xs text-gray-500">({markers.length})</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5 text-xs">
            {statusSummary.beneficial > 0 && <span className="text-green-400">{statusSummary.beneficial} good</span>}
            {statusSummary.concern > 0 && <span className="text-yellow-400">{statusSummary.concern} concern</span>}
            {statusSummary.major_concern > 0 && <span className="text-red-400">{statusSummary.major_concern} major</span>}
          </div>
          {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
        </div>
      </button>

      {/* Marker grid */}
      {expanded && (
        <div className="border-t border-port-border/50 p-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {markers.map(marker => {
              const isExpanded = expandedMarker === marker.id;
              const badge = STATUS_BADGE[marker.status] || STATUS_BADGE.not_found;
              const dot = STATUS_DOT[marker.status] || STATUS_DOT.not_found;

              return (
                <div
                  key={marker.id}
                  className={`rounded-md border transition-colors ${
                    isExpanded
                      ? 'border-port-accent/40 bg-port-bg/60 col-span-1 sm:col-span-2 lg:col-span-3'
                      : 'border-port-border/40 bg-port-card/50 hover:border-port-border'
                  }`}
                >
                  {/* Compact marker tile */}
                  <button
                    onClick={() => setExpandedMarker(isExpanded ? null : marker.id)}
                    className="w-full p-2.5 text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                          <span className="text-xs font-medium text-white truncate">{marker.name}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 ml-3.5">
                          <span className="text-[10px] text-gray-500 font-mono">{marker.gene}</span>
                          <span className="text-[10px] text-gray-600 font-mono">{marker.rsid}</span>
                        </div>
                      </div>
                      {marker.genotype && (
                        <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] font-mono text-white flex-shrink-0">
                          {marker.genotype}
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Expanded detail panel */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 border-t border-port-border/30">
                      {/* Status + genotype row */}
                      <div className="flex items-center gap-2 pt-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.bg} ${badge.text} border ${badge.border}`}>
                          {STATUS_LABEL[marker.status] || marker.status}
                        </span>
                        {marker.genotype && (
                          <span className="px-2 py-0.5 rounded bg-port-card border border-port-border text-xs font-mono text-white">
                            {marker.genotype}
                          </span>
                        )}
                        <span className="text-xs text-gray-500 font-mono">{marker.gene} &middot; {marker.rsid}</span>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-gray-400 leading-relaxed">{marker.description}</p>

                      {/* Implications */}
                      {marker.implications && (
                        <div className="p-2 rounded bg-port-card border border-port-border">
                          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Implications</span>
                          <p className="text-sm text-gray-300 mt-1">{marker.implications}</p>
                        </div>
                      )}

                      {/* Location */}
                      <div className="flex gap-4 text-xs text-gray-500">
                        {marker.chromosome && <span>Chr {marker.chromosome}</span>}
                        {marker.position && <span>Pos {marker.position}</span>}
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Notes</label>
                        <textarea
                          value={marker.notes || ''}
                          onChange={(e) => onEditNotes(marker.id, e.target.value)}
                          placeholder="Add personal notes..."
                          rows={2}
                          className="w-full mt-1 p-2 bg-port-card border border-port-border rounded text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-port-accent"
                        />
                      </div>

                      {/* References */}
                      {marker.references?.length > 0 && (
                        <div>
                          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">References</span>
                          <ul className="mt-1 space-y-1">
                            {marker.references.map((ref, i) => (
                              <li key={i}>
                                <a href={ref} target="_blank" rel="noopener noreferrer" className="text-xs text-port-accent hover:underline break-all">
                                  {ref}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Delete */}
                      <div className="flex justify-end">
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteMarker(marker.id); }}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                          Remove marker
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
