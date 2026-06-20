import { useState, useEffect, useCallback } from 'react';
import { Download, Archive, RefreshCw, Package, AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import socket from '../../../services/socket';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import { downloadBlob } from '../../../lib/downloadBlob';
import { formatBytes } from '../../../utils/formatters';

// Legacy Bundle surface (#1432) — pick sections, preview stats, generate, and
// download the portable identity zip. The server foundation (#901 Phase 1)
// streams `Content-Disposition: attachment` and emits `legacy-export:*` socket
// events for per-section progress.

// Build the count summary line for a section's preview metadata. The server
// stamps each section with `{ label, present, included, ...counts }`; the
// counts are the remaining numeric keys (memories, stories, goals, …).
const META_KEYS = new Set(['label', 'present', 'included', 'source']);
function describeCounts(meta) {
  const parts = Object.entries(meta)
    .filter(([k, v]) => !META_KEYS.has(k) && typeof v === 'number' && v > 0)
    .map(([k, v]) => `${v} ${k}`);
  return parts.join(' · ');
}

export default function LegacyExportTab() {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    // ExportTab-style: tolerate a failed preview with a falsy fallback so the
    // tab still renders an empty state instead of throwing.
    const data = await api.getLegacyExportPreview({ silent: true }).catch(() => null);
    setPreview(data);
    // Default selection: every present section.
    if (data?.sections) {
      setSelected(Object.entries(data.sections).filter(([, m]) => m.present).map(([k]) => k));
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadPreview(); }, [loadPreview]);

  // Per-section progress from the server-side bundle build.
  useEffect(() => {
    const onProgress = (payload) => setProgress(payload || null);
    const onCompleted = () => setProgress(null);
    socket.on('legacy-export:progress', onProgress);
    socket.on('legacy-export:completed', onCompleted);
    return () => {
      socket.off('legacy-export:progress', onProgress);
      socket.off('legacy-export:completed', onCompleted);
    };
  }, []);

  const toggleSection = (key) => {
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const sections = preview?.sections ? Object.entries(preview.sections) : [];
  const presentSections = sections.filter(([, m]) => m.present);
  const selectedPresent = selected.filter(k => preview?.sections?.[k]?.present);
  const canGenerate = !generating && selectedPresent.length > 0;

  const handleGenerate = async () => {
    setGenerating(true);
    setProgress(null);
    // If every present section is selected, send no filter (server treats
    // omitted `sections` as "all") so a future section is included by default.
    const allPresent = selectedPresent.length === presentSections.length;
    const buffer = await api
      .downloadLegacyExport({ sections: allPresent ? null : selectedPresent }, { silent: true })
      .catch(() => null);
    setGenerating(false);
    setProgress(null);
    if (!buffer) {
      toast.error('Failed to build legacy bundle');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(buffer, `legacy-export-${date}.zip`, 'application/zip');
    toast.success('Legacy bundle downloaded');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-6">
      {/* Intro */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-start gap-3">
          <Archive className="w-6 h-6 text-port-accent shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-white">Legacy Bundle</h3>
            <p className="text-sm text-gray-400 mt-1">
              A portable, human-readable archive of your identity — Markdown + JSON for each
              section, zipped with a manifest. Pick what to include and download a time capsule
              you can keep, share, or hand on.
            </p>
          </div>
        </div>
      </div>

      {/* Section picker */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Sections ({selectedPresent.length})</h3>
          <button
            onClick={loadPreview}
            className="flex items-center gap-1.5 text-xs py-1 px-2 min-h-[32px] text-gray-400 hover:text-white"
            title="Re-scan sections"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {presentSections.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No identity data available yet — build out your Digital Twin to populate the bundle.
          </p>
        ) : (
          <div className="space-y-1">
            {presentSections.map(([key, meta]) => {
              const counts = describeCounts(meta);
              return (
                <label
                  key={key}
                  htmlFor={`legacy-section-${key}`}
                  className="flex items-center gap-3 p-2 min-h-[44px] rounded hover:bg-port-border cursor-pointer"
                >
                  <input
                    id={`legacy-section-${key}`}
                    type="checkbox"
                    checked={selected.includes(key)}
                    onChange={() => toggleSection(key)}
                    className="w-5 h-5 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white">{meta.label || key}</div>
                    {counts && <div className="text-xs text-gray-500">{counts}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {/* Estimated size */}
        {preview && (
          <div className="mt-4 pt-4 border-t border-port-border flex items-center gap-2 text-xs text-gray-500">
            <Package size={14} />
            <span>
              ~{preview.fileCount} files
              {preview.estimatedBytes != null && ` · ${formatBytes(preview.estimatedBytes)} (full bundle)`}
            </span>
          </div>
        )}

        {/* Large-bundle warning — the server flags an estimate over its soft cap
            (it never truncates; the zip itself is compressed and smaller). */}
        {preview?.sizeWarning && (
          <div className="mt-3 flex items-start gap-2 rounded border border-port-warning/40 bg-port-warning/10 p-2.5 text-xs text-port-warning">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              Large bundle — about {formatBytes(preview.sizeWarning.estimatedBytes)} of identity data
              {preview.sizeWarning.largestSection && `, mostly from “${preview.sizeWarning.largestSection}”`}.
              The download is compressed and smaller; deselect sections you don't need to trim it.
            </span>
          </div>
        )}
      </div>

      {/* Generate */}
      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {generating ? (
          <>
            <BrailleSpinner />
            {progress ? 'Building bundle…' : 'Generating…'}
          </>
        ) : (
          <>
            <Download className="w-5 h-5" />
            Generate &amp; Download
          </>
        )}
      </button>
    </div>
  );
}
