import { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import {
  Upload, Download, RefreshCw, Trash2, Search, Dna, AlertTriangle, Save
} from 'lucide-react';
import { unzipSync, strFromU8 } from 'fflate';
import * as api from '../../../services/api';
import GenomeCategoryCard from '../GenomeCategoryCard';

const CATEGORY_META = {
  longevity:          { emoji: '\u2728', label: 'Longevity',            color: 'purple' },
  cardiovascular:     { emoji: '\u2764\uFE0F', label: 'Cardiovascular',       color: 'rose' },
  iron:               { emoji: '\u{1FA78}', label: 'Iron Metabolism',      color: 'red' },
  methylation:        { emoji: '\u{1F52C}', label: 'Methylation',          color: 'blue' },
  nutrient:           { emoji: '\u{1F34E}', label: 'Nutrient Metabolism',  color: 'emerald' },
  caffeine:           { emoji: '\u2615',  label: 'Caffeine',             color: 'amber' },
  detox:              { emoji: '\u{1F6E1}\uFE0F', label: 'Detoxification',      color: 'green' },
  inflammation:       { emoji: '\u{1F525}', label: 'Inflammation',         color: 'orange' },
  tumor_suppression:  { emoji: '\u{1F9EC}', label: 'Tumor Suppression',    color: 'indigo' },
  cognitive:          { emoji: '\u{1F9E0}', label: 'Cognitive',            color: 'cyan' },
  sleep:              { emoji: '\u{1F319}', label: 'Sleep & Circadian',    color: 'violet' },
  athletic:           { emoji: '\u{1F4AA}', label: 'Athletic Performance', color: 'sky' },
  skin:               { emoji: '\u2600\uFE0F', label: 'Skin & UV Response',   color: 'yellow' }
};

const STAR_LABELS = ['No criteria', 'Single submitter', 'Multiple submitters', 'Expert panel', 'Practice guideline'];

const SEVERITY_LABELS = {
  pathogenic: { label: 'Pathogenic', bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/30' },
  drug_response: { label: 'Drug Response', bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/30' },
  risk_factor: { label: 'Risk Factor', bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  protective: { label: 'Protective', bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/30' }
};

export default function GenomeTab() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchRsid, setSearchRsid] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingNotes, setSavingNotes] = useState(null);

  // ClinVar state
  const [clinvarStatus, setClinvarStatus] = useState(null);
  const [clinvarSyncing, setClinvarSyncing] = useState(false);
  const [clinvarProgress, setClinvarProgress] = useState('');
  const [clinvarResults, setClinvarResults] = useState(null);
  const [clinvarScanning, setClinvarScanning] = useState(false);
  const [clinvarExpanded, setClinvarExpanded] = useState({});
  const [clinvarFilter, setClinvarFilter] = useState('all');
  const [clinvarStarFilter, setClinvarStarFilter] = useState(0);
  const fileInputRef = useRef(null);
  const dropRef = useRef(null);
  const notesTimerRef = useRef({});

  const fetchSummary = useCallback(async () => {
    const [data, cvStatus] = await Promise.all([
      api.getGenomeSummary().catch(() => ({ uploaded: false })),
      api.getClinvarStatus().catch(() => ({ synced: false }))
    ]);
    setSummary(data);
    setClinvarStatus(cvStatus);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // Debounced notes save
  const handleNotesChange = useCallback((markerId, notes) => {
    // Optimistic UI update
    setSummary(prev => {
      if (!prev?.savedMarkers?.[markerId]) return prev;
      return {
        ...prev,
        savedMarkers: {
          ...prev.savedMarkers,
          [markerId]: { ...prev.savedMarkers[markerId], notes }
        }
      };
    });

    // Debounce the API call
    if (notesTimerRef.current[markerId]) {
      clearTimeout(notesTimerRef.current[markerId]);
    }
    notesTimerRef.current[markerId] = setTimeout(async () => {
      setSavingNotes(markerId);
      await api.updateGenomeMarkerNotes(markerId, notes).catch(() => {
        toast.error('Failed to save notes');
      });
      setSavingNotes(null);
    }, 800);
  }, []);

  const handleFileUpload = useCallback(async (file) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error('File too large (max 50MB)');
      return;
    }

    setUploading(true);
    const isZip = file.name.endsWith('.zip') || file.type === 'application/zip';

    if (isZip) {
      // Read as ArrayBuffer, unzip, and extract the .txt file inside
      const reader = new FileReader();
      reader.onload = async (e) => {
        const zipData = new Uint8Array(e.target.result);
        const unzipped = unzipSync(zipData);
        const txtFile = Object.keys(unzipped).find(name => name.endsWith('.txt'));
        if (!txtFile) {
          toast.error('No .txt file found inside the zip');
          setUploading(false);
          return;
        }
        const content = strFromU8(unzipped[txtFile]);
        const result = await api.uploadGenomeFile(content, txtFile).catch(() => null);
        if (result) {
          toast.success(`Genome uploaded: ${result.snpCount.toLocaleString()} SNPs found`);
          await fetchSummary();
        }
        setUploading(false);
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Read as text directly
      const reader = new FileReader();
      reader.onload = async (e) => {
        const content = e.target.result;
        const result = await api.uploadGenomeFile(content, file.name).catch(() => null);
        if (result) {
          toast.success(`Genome uploaded: ${result.snpCount.toLocaleString()} SNPs found`);
          await fetchSummary();
        }
        setUploading(false);
      };
      reader.readAsText(file);
    }
  }, [fetchSummary]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove('border-port-accent');
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }, [handleFileUpload]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.add('border-port-accent');
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove('border-port-accent');
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    const result = await api.scanGenomeMarkers().catch(() => null);
    if (result) {
      toast.success(`Scanned ${result.markers.length} curated markers`);
      await fetchSummary();
    }
    setScanning(false);
  }, [fetchSummary]);

  const handleSearch = useCallback(async () => {
    if (!searchRsid || !/^rs\d+$/.test(searchRsid)) {
      toast.error('Enter a valid rsid (e.g., rs1801133)');
      return;
    }
    setSearching(true);
    setSearchResult(null);
    const result = await api.searchGenomeSNP(searchRsid).catch(() => null);
    setSearchResult(result);
    setSearching(false);
  }, [searchRsid]);

  const handleSaveSearchResult = useCallback(async () => {
    if (!searchResult?.found) return;
    const data = {
      rsid: searchResult.rsid,
      genotype: searchResult.genotype,
      chromosome: searchResult.chromosome,
      position: searchResult.position,
      name: searchResult.name || searchResult.rsid,
      category: searchResult.category || 'other',
      gene: searchResult.gene || '',
      description: searchResult.description || '',
      implications: searchResult.implications || '',
      status: searchResult.status || 'typical'
    };
    const saved = await api.saveGenomeMarker(data).catch(() => null);
    if (saved) {
      toast.success(`Marker ${searchResult.rsid} saved`);
      await fetchSummary();
    }
  }, [searchResult, fetchSummary]);

  const handleDeleteMarker = useCallback(async (markerId) => {
    await api.deleteGenomeMarker(markerId).catch(() => null);
    toast.success('Marker removed');
    await fetchSummary();
  }, [fetchSummary]);

  const handleDeleteGenome = useCallback(async () => {
    setDeleting(true);
    await api.deleteGenomeData().catch(() => null);
    toast.success('Genome data deleted');
    setConfirmDelete(false);
    setDeleting(false);
    setSummary({ uploaded: false });
    setClinvarResults(null);
  }, []);

  // ClinVar handlers
  const handleClinvarSync = useCallback(async () => {
    setClinvarSyncing(true);
    setClinvarProgress('Starting ClinVar sync...');
    const result = await api.syncClinvar().catch((err) => {
      setClinvarProgress('');
      return null;
    });
    if (result) {
      toast.success(`ClinVar synced: ${result.variantCount?.toLocaleString()} variants indexed`);
      setClinvarStatus(result);
    }
    setClinvarSyncing(false);
    setClinvarProgress('');
  }, []);

  const handleClinvarScan = useCallback(async () => {
    setClinvarScanning(true);
    const result = await api.scanClinvar().catch(() => null);
    if (result) {
      setClinvarResults(result);
      toast.success(`ClinVar scan: ${result.totalMatched} variants found in your genome`);
    }
    setClinvarScanning(false);
  }, []);


  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  // Upload state — no genome data yet
  if (!summary?.uploaded) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <Dna className="w-12 h-12 text-purple-400 mx-auto" />
          <h2 className="text-xl font-bold text-white">Genome Data</h2>
          <p className="text-gray-400">Upload your 23andMe raw data export to track health and longevity markers.</p>
        </div>

        {/* Drop zone */}
        <div
          ref={dropRef}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className="border-2 border-dashed border-port-border rounded-lg p-12 text-center transition-colors hover:border-gray-500 cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <div className="space-y-3">
              <RefreshCw className="w-10 h-10 text-port-accent animate-spin mx-auto" />
              <p className="text-gray-400">Parsing genome data...</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Upload className="w-10 h-10 text-gray-500 mx-auto" />
              <p className="text-gray-300">Drag and drop your 23andMe raw data file</p>
              <p className="text-sm text-gray-500">or click to browse</p>
              <p className="text-xs text-gray-600">Accepts .zip or .txt files from 23andMe (typically 15-25MB)</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.tsv,.csv,.zip"
            className="hidden"
            onChange={(e) => handleFileUpload(e.target.files[0])}
          />
        </div>

        <div className="p-3 rounded bg-port-card border border-port-border text-sm text-gray-400">
          <p className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-yellow-500 mt-0.5 flex-shrink-0" />
            <span>
              Your genome data is stored locally on this server only. It is never sent to external services.
              All analysis is performed locally using a curated list of known health markers.
            </span>
          </p>
        </div>
      </div>
    );
  }

  // Loaded state — genome data exists
  const markers = summary.savedMarkers ? Object.entries(summary.savedMarkers).map(([id, m]) => ({ id, ...m })) : [];

  // Group markers by category
  const grouped = {};
  for (const marker of markers) {
    const cat = marker.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(marker);
  }

  // Sort categories by a defined order
  const categoryOrder = ['longevity', 'cardiovascular', 'tumor_suppression', 'iron', 'methylation', 'nutrient', 'cognitive', 'caffeine', 'sleep', 'athletic', 'detox', 'inflammation', 'skin'];
  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="SNPs" value={summary.snpCount?.toLocaleString()} />
        <StatCard label="Build" value={summary.build} />
        <StatCard label="Markers" value={summary.markerCount || 0} />
        <StatCard label="Uploaded" value={summary.uploadedAt ? new Date(summary.uploadedAt).toLocaleDateString() : 'N/A'} />
      </div>

      {/* Status summary */}
      {summary.statusCounts && (
        <div className="flex flex-wrap gap-2 text-sm">
          {summary.statusCounts.beneficial > 0 && (
            <span className="px-2 py-1 rounded bg-green-500/10 text-green-400 border border-green-500/20">
              {summary.statusCounts.beneficial} beneficial
            </span>
          )}
          {summary.statusCounts.typical > 0 && (
            <span className="px-2 py-1 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
              {summary.statusCounts.typical} typical
            </span>
          )}
          {summary.statusCounts.concern > 0 && (
            <span className="px-2 py-1 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              {summary.statusCounts.concern} concern
            </span>
          )}
          {summary.statusCounts.major_concern > 0 && (
            <span className="px-2 py-1 rounded bg-red-500/10 text-red-400 border border-red-500/20">
              {summary.statusCounts.major_concern} major concern
            </span>
          )}
          {summary.statusCounts.not_found > 0 && (
            <span className="px-2 py-1 rounded bg-gray-500/10 text-gray-400 border border-gray-500/20">
              {summary.statusCounts.not_found} not found
            </span>
          )}
        </div>
      )}

      {/* Actions row */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleScan}
          disabled={scanning}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent/20 text-port-accent border border-port-accent/30 rounded hover:bg-port-accent/30 transition-colors disabled:opacity-50 text-sm"
        >
          {scanning ? <RefreshCw size={14} className="animate-spin" /> : <Dna size={14} />}
          {scanning ? 'Scanning...' : 'Scan Known Markers'}
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          className="flex items-center gap-2 px-3 py-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded hover:bg-red-500/20 transition-colors text-sm"
        >
          <Trash2 size={14} />
          Delete Genome
        </button>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="p-4 rounded bg-red-500/10 border border-red-500/30 space-y-3">
          <p className="text-sm text-red-400 font-medium">
            Are you sure? This will permanently delete your raw genome file and all saved markers.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleDeleteGenome}
              disabled={deleting}
              className="px-3 py-1.5 bg-red-500/20 text-red-400 border border-red-500/30 rounded text-sm hover:bg-red-500/30 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Yes, delete everything'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 bg-port-card border border-port-border rounded text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Curated Markers by category */}
      {sortedCategories.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-white">Curated Markers</h3>
          {sortedCategories.map(cat => {
            const meta = CATEGORY_META[cat] || { emoji: '\u{1F9EC}', label: cat, color: 'blue' };
            return (
              <GenomeCategoryCard
                key={cat}
                category={cat}
                label={meta.label}
                emoji={meta.emoji}
                color={meta.color}
                markers={grouped[cat]}
                onEditNotes={handleNotesChange}
                onDeleteMarker={handleDeleteMarker}
              />
            );
          })}
        </div>
      )}

      {markers.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <Dna className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p>No markers saved yet. Click "Scan Known Markers" to analyze your genome against 30 curated health markers.</p>
        </div>
      )}

      {/* ClinVar Database section */}
      <div className="border-t border-port-border pt-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-lg font-semibold text-white">ClinVar Database</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              NCBI&apos;s database of clinically significant genetic variants — pathogenic mutations, risk factors, drug responses, and protective variants.
            </p>
          </div>
        </div>

        {/* ClinVar status + actions */}
        <div className="flex flex-wrap items-center gap-2">
          {!clinvarStatus?.synced ? (
            <button
              onClick={handleClinvarSync}
              disabled={clinvarSyncing}
              className="flex items-center gap-2 px-3 py-2 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded hover:bg-purple-500/30 transition-colors disabled:opacity-50 text-sm"
            >
              {clinvarSyncing ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
              {clinvarSyncing ? 'Syncing...' : 'Sync ClinVar Database'}
            </button>
          ) : (
            <>
              <span className="text-xs text-gray-500">
                {clinvarStatus.variantCount?.toLocaleString()} variants indexed
                {clinvarStatus.syncedAt && ` (synced ${new Date(clinvarStatus.syncedAt).toLocaleDateString()})`}
              </span>
              <button
                onClick={handleClinvarScan}
                disabled={clinvarScanning}
                className="flex items-center gap-2 px-3 py-2 bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded hover:bg-purple-500/30 transition-colors disabled:opacity-50 text-sm"
              >
                {clinvarScanning ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                {clinvarScanning ? 'Scanning...' : 'Scan Against ClinVar'}
              </button>
              <button
                onClick={handleClinvarSync}
                disabled={clinvarSyncing}
                className="px-3 py-2 bg-port-card border border-port-border rounded text-xs text-gray-500 hover:text-white transition-colors disabled:opacity-50"
              >
                {clinvarSyncing ? 'Re-syncing...' : 'Re-sync'}
              </button>
            </>
          )}
        </div>

        {/* Sync progress */}
        {clinvarProgress && (
          <div className="flex items-center gap-2 p-3 rounded bg-purple-500/10 border border-purple-500/20 text-sm text-purple-300">
            <RefreshCw size={14} className="animate-spin flex-shrink-0" />
            {clinvarProgress}
          </div>
        )}

        {/* ClinVar scan results */}
        {clinvarResults && (
          <div className="space-y-3">
            {/* Summary badges */}
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="px-2 py-1 rounded bg-port-card border border-port-border text-gray-300">
                {clinvarResults.totalMatched} total matches
              </span>
              {clinvarResults.bySeverity.pathogenic > 0 && (
                <span className="px-2 py-1 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                  {clinvarResults.bySeverity.pathogenic} pathogenic
                </span>
              )}
              {clinvarResults.bySeverity.risk_factor > 0 && (
                <span className="px-2 py-1 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                  {clinvarResults.bySeverity.risk_factor} risk factors
                </span>
              )}
              {clinvarResults.bySeverity.drug_response > 0 && (
                <span className="px-2 py-1 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  {clinvarResults.bySeverity.drug_response} drug response
                </span>
              )}
              {clinvarResults.bySeverity.protective > 0 && (
                <span className="px-2 py-1 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                  {clinvarResults.bySeverity.protective} protective
                </span>
              )}
            </div>

            {/* Filters */}
            <div className="flex flex-wrap gap-2">
              <div className="flex gap-1 text-xs">
                {['all', 'pathogenic', 'risk_factor', 'drug_response', 'protective'].map(f => (
                  <button
                    key={f}
                    onClick={() => setClinvarFilter(f)}
                    className={`px-2 py-1 rounded border transition-colors ${
                      clinvarFilter === f
                        ? 'bg-port-accent/20 text-port-accent border-port-accent/30'
                        : 'bg-port-card border-port-border text-gray-500 hover:text-white'
                    }`}
                  >
                    {f === 'all' ? 'All' : (SEVERITY_LABELS[f]?.label || f)}
                  </button>
                ))}
              </div>
              <select
                value={clinvarStarFilter}
                onChange={(e) => setClinvarStarFilter(Number(e.target.value))}
                className="px-2 py-1 rounded bg-port-card border border-port-border text-xs text-gray-400 focus:outline-none"
              >
                <option value={0}>Any evidence</option>
                <option value={1}>1+ star</option>
                <option value={2}>2+ stars</option>
                <option value={3}>3+ stars (expert panel)</option>
              </select>
            </div>

            {/* Findings list */}
            <div className="border rounded-lg border-port-border overflow-hidden">
              <div className="max-h-[600px] overflow-auto">
                {clinvarResults.findings
                  .filter(f => clinvarFilter === 'all' || f.severity === clinvarFilter)
                  .filter(f => f.reviewStars >= clinvarStarFilter)
                  .slice(0, 200)
                  .map((finding, i) => {
                    const sev = SEVERITY_LABELS[finding.severity] || SEVERITY_LABELS.risk_factor;
                    const isOpen = clinvarExpanded[`cv-${i}`];
                    return (
                      <div key={`${finding.rsid}-${i}`} className="border-b border-port-border/50 last:border-b-0">
                        <button
                          onClick={() => setClinvarExpanded(prev => ({ ...prev, [`cv-${i}`]: !prev[`cv-${i}`] }))}
                          className="w-full flex items-center justify-between p-2.5 text-left hover:bg-white/5 transition-colors text-sm"
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <span className="font-mono text-xs text-gray-500 w-24 flex-shrink-0">{finding.rsid}</span>
                            <span className="text-white font-medium truncate">{finding.gene}</span>
                            <span className={`px-1.5 py-0.5 rounded text-xs ${sev.bg} ${sev.text} border ${sev.border} flex-shrink-0`}>
                              {sev.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            <span className="text-xs text-yellow-500" title={STAR_LABELS[finding.reviewStars] || ''}>
                              {'★'.repeat(finding.reviewStars)}{'☆'.repeat(4 - finding.reviewStars)}
                            </span>
                          </div>
                        </button>
                        {isOpen && (
                          <div className="px-3 pb-3 space-y-2 bg-port-bg/30 text-sm">
                            <div className="flex gap-4 text-xs text-gray-500">
                              <span>Chr {finding.chromosome}</span>
                              <span>Pos {finding.position}</span>
                              <span className="font-mono">{finding.genotype}</span>
                              <span>{finding.submissions} submission{finding.submissions > 1 ? 's' : ''}</span>
                            </div>
                            <div className="text-xs text-gray-400">
                              <span className="font-medium text-gray-500">Classification: </span>
                              {finding.significance}
                            </div>
                            {finding.conditions.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {finding.conditions.map((c, j) => (
                                  <span key={j} className="px-1.5 py-0.5 rounded bg-port-card border border-port-border text-xs text-gray-300">
                                    {c}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="text-xs text-gray-500">
                              Review: {STAR_LABELS[finding.reviewStars] || 'No criteria provided'}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
              {clinvarResults.findings
                .filter(f => clinvarFilter === 'all' || f.severity === clinvarFilter)
                .filter(f => f.reviewStars >= clinvarStarFilter)
                .length > 200 && (
                <div className="p-2 text-center text-xs text-gray-500 border-t border-port-border bg-port-card">
                  Showing first 200 of {clinvarResults.findings.filter(f => clinvarFilter === 'all' || f.severity === clinvarFilter).filter(f => f.reviewStars >= clinvarStarFilter).length} results. Use filters to narrow.
                </div>
              )}
            </div>

            <p className="text-xs text-gray-600">
              Data from NCBI ClinVar. For research/informational purposes only — consult a genetic counselor for clinical interpretation.
            </p>
          </div>
        )}
      </div>

      {/* Search section */}
      <div className="border-t border-port-border pt-6 space-y-4">
        <h3 className="text-lg font-semibold text-white">Search SNP</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchRsid}
            onChange={(e) => setSearchRsid(e.target.value.toLowerCase().trim())}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="rs1801133"
            className="flex-1 max-w-xs px-3 py-2 bg-port-card border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent font-mono"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-300 hover:text-white hover:border-port-accent transition-colors disabled:opacity-50"
          >
            {searching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
            Search
          </button>
        </div>

        {/* Search result */}
        {searchResult && (
          <div className="p-4 rounded bg-port-card border border-port-border space-y-3">
            {searchResult.found ? (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-white">{searchResult.rsid}</span>
                    {searchResult.gene && <span className="text-sm text-gray-500">{searchResult.gene}</span>}
                    <span className="px-2 py-0.5 rounded bg-port-bg border border-port-border text-xs font-mono text-white">
                      {searchResult.genotype}
                    </span>
                  </div>
                  {searchResult.status && (
                    <StatusBadgeInline status={searchResult.status} />
                  )}
                </div>
                <div className="text-xs text-gray-500 flex gap-4">
                  <span>Chr {searchResult.chromosome}</span>
                  <span>Pos {searchResult.position}</span>
                  {searchResult.curated && <span className="text-purple-400">Curated marker</span>}
                </div>
                {searchResult.description && (
                  <p className="text-sm text-gray-400">{searchResult.description}</p>
                )}
                {searchResult.implications && (
                  <p className="text-sm text-gray-300">{searchResult.implications}</p>
                )}
                {searchResult.curated && (
                  <button
                    onClick={handleSaveSearchResult}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/20 text-port-accent border border-port-accent/30 rounded text-sm hover:bg-port-accent/30 transition-colors"
                  >
                    <Save size={14} />
                    Save Marker
                  </button>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500">
                SNP <span className="font-mono text-white">{searchResult.rsid || searchRsid}</span> not found in your genome data.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Saving indicator */}
      {savingNotes && (
        <div className="fixed bottom-4 right-4 px-3 py-2 bg-port-card border border-port-border rounded shadow-lg text-xs text-gray-400 flex items-center gap-2">
          <RefreshCw size={12} className="animate-spin" />
          Saving notes...
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="p-3 rounded bg-port-card border border-port-border">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-lg font-bold text-white mt-1">{value}</div>
    </div>
  );
}

function StatusBadgeInline({ status }) {
  const styles = {
    beneficial: 'bg-green-500/20 text-green-400 border-green-500/30',
    typical: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    concern: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    major_concern: 'bg-red-500/20 text-red-400 border-red-500/30',
    not_found: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  };
  const labels = {
    beneficial: 'Beneficial',
    typical: 'Typical',
    concern: 'Concern',
    major_concern: 'Major Concern',
    not_found: 'Not Found'
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium border ${styles[status] || styles.not_found}`}>
      {labels[status] || status}
    </span>
  );
}
