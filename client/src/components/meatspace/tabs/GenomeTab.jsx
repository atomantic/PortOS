import { useState, useEffect, useCallback, useRef } from 'react';
import toast from '../../ui/Toast';
import {Upload, Download, Trash2, Search, Dna, AlertTriangle, Save} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
// Native ZIP parser — replaces fflate's unzipSync/strFromU8
async function parseZipText(arrayBuffer, ext = '.txt') {
  const data = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Locate EOCD record (search backwards from end, max 64KB comment)
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Invalid ZIP file');

  const cdOffset = view.getUint32(eocd + 16, true);
  const cdEntries = view.getUint16(eocd + 8, true);

  // Parse central directory to find target entry
  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const fnLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const lhOffset = view.getUint32(pos + 42, true);
    const filename = new TextDecoder().decode(data.slice(pos + 46, pos + 46 + fnLen));

    if (filename.endsWith(ext)) {
      const lhFnLen = view.getUint16(lhOffset + 26, true);
      const lhExtraLen = view.getUint16(lhOffset + 28, true);
      const dataStart = lhOffset + 30 + lhFnLen + lhExtraLen;
      const compressed = data.slice(dataStart, dataStart + compressedSize);

      if (method === 0) return { filename, content: new TextDecoder().decode(compressed) };
      if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        const chunks = [];
        const reader = ds.readable.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
        return { filename, content: new TextDecoder().decode(out) };
      }
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
    pos += 46 + fnLen + extraLen + commentLen;
  }
  throw new Error(`No ${ext} file found inside the zip`);
}
import * as api from '../../../services/api';
import GenomeCategoryCard from '../GenomeCategoryCard';
import EpigeneticTracker from '../EpigeneticTracker';

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
  cognitive_decline:  { emoji: '\u{1F9D3}', label: 'Cognitive Decline & Dementia Risk', color: 'rose' },
  sleep:              { emoji: '\u{1F319}', label: 'Sleep & Circadian',    color: 'violet' },
  athletic:           { emoji: '\u{1F4AA}', label: 'Athletic Performance', color: 'sky' },
  skin:               { emoji: '\u2600\uFE0F', label: 'Skin & UV Response',   color: 'yellow' },
  diabetes:           { emoji: '\u{1FA78}', label: 'Blood Sugar & Diabetes', color: 'amber' },
  gut_health:         { emoji: '\u{1F966}', label: 'Gut Health & Digestion', color: 'lime' },
  autoimmune:         { emoji: '\u{1F6E1}\uFE0F', label: 'Autoimmune Risk',       color: 'pink' },
  thyroid:            { emoji: '\u{1F9EA}', label: 'Thyroid & Hormones',   color: 'teal' },
  eye_health:         { emoji: '\u{1F441}\uFE0F', label: 'Eye Health',            color: 'sky' },
  mental_health:      { emoji: '\u{1F9E0}', label: 'Mental Health',         color: 'violet' },
  bone_health:        { emoji: '\u{1F9B4}', label: 'Bone Health',           color: 'stone' },
  pharmacogenomics:   { emoji: '\u{1F48A}', label: 'Pharmacogenomics',     color: 'fuchsia' },
  cancer_breast:      { emoji: '\u{1F397}\uFE0F', label: 'Breast & Ovarian Cancer', color: 'pink' },
  cancer_prostate:    { emoji: '\u{1F6E1}\uFE0F', label: 'Prostate Cancer',       color: 'blue' },
  cancer_colorectal:  { emoji: '\u{1F9EC}', label: 'Colorectal Cancer',    color: 'amber' },
  cancer_lung:        { emoji: '\u{1FAC1}', label: 'Lung Cancer',           color: 'slate' },
  cancer_melanoma:    { emoji: '\u2600\uFE0F', label: 'Melanoma Risk',         color: 'stone' },
  cancer_bladder:     { emoji: '\u{1F9EC}', label: 'Bladder Cancer',       color: 'zinc' },
  cancer_digestive:   { emoji: '\u{1F9EC}', label: 'Digestive Cancer',     color: 'lime' },
  hair:               { emoji: '\u2702\uFE0F', label: 'Hair Loss',             color: 'zinc' },
  hearing:            { emoji: '\u{1F442}', label: 'Hearing',              color: 'slate' },
  pain:               { emoji: '\u26A1',  label: 'Pain Sensitivity',     color: 'orange' }
};

const STAR_LABELS = ['No criteria', 'Single submitter', 'Multiple submitters', 'Expert panel', 'Practice guideline'];

const STATUS_FILTERS = [
  { key: 'beneficial', label: 'Beneficial', active: 'bg-green-500/20 text-green-400 border border-green-500/30', inactive: 'bg-port-card border border-port-border text-green-400/60 hover:text-green-400' },
  { key: 'typical', label: 'Typical', active: 'bg-blue-500/20 text-blue-400 border border-blue-500/30', inactive: 'bg-port-card border border-port-border text-blue-400/60 hover:text-blue-400' },
  { key: 'concern', label: 'Concern', active: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30', inactive: 'bg-port-card border border-port-border text-yellow-400/60 hover:text-yellow-400' },
  { key: 'major_concern', label: 'Major Concern', active: 'bg-red-500/20 text-red-400 border border-red-500/30', inactive: 'bg-port-card border border-port-border text-red-400/60 hover:text-red-400' }
];

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
  const [statusFilter, setStatusFilter] = useState('all');
  const [jumpOpen, setJumpOpen] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);

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
  const jumpRef = useRef(null);

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

  useEffect(() => {
    if (!jumpOpen) return;
    const handleClickOutside = (e) => {
      if (jumpRef.current && !jumpRef.current.contains(e.target)) setJumpOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [jumpOpen]);

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
        let parsed;
        try {
          parsed = await parseZipText(e.target.result);
        } catch (err) {
          toast.error(err.message || 'Failed to read zip');
          setUploading(false);
          return;
        }
        const result = await api.uploadGenomeFile(parsed.content, parsed.filename).catch(() => null);
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
    const result = await api.syncClinvar().catch(() => {
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
        <BrailleSpinner text="Loading" />
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
              <BrailleSpinner />
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
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => handleFileUpload(e.target.files[0])}
          />
        </div>

        <div className="p-3 rounded bg-port-card border border-port-border text-sm text-gray-400">
          <p className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-yellow-500 mt-0.5 shrink-0" />
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

  // Status counts across all markers
  const statusCounts = markers.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  // Attention-needed markers (concerns + major concerns), sorted by severity
  const attentionMarkers = markers
    .filter(m => m.status === 'major_concern' || m.status === 'concern')
    .sort((a, b) => (a.status === 'major_concern' ? 0 : 1) - (b.status === 'major_concern' ? 0 : 1));

  // Apply status filter to categories
  const filteredGrouped = {};
  for (const [cat, catMarkers] of Object.entries(grouped)) {
    const filtered = statusFilter === 'all'
      ? catMarkers
      : catMarkers.filter(m => m.status === statusFilter);
    if (filtered.length > 0) filteredGrouped[cat] = filtered;
  }

  const categoryOrder = ['longevity', 'cardiovascular', 'tumor_suppression', 'cancer_breast', 'cancer_prostate', 'cancer_colorectal', 'cancer_lung', 'cancer_melanoma', 'cancer_bladder', 'cancer_digestive', 'cognitive_decline', 'mental_health', 'iron', 'methylation', 'nutrient', 'diabetes', 'gut_health', 'cognitive', 'caffeine', 'sleep', 'athletic', 'detox', 'inflammation', 'autoimmune', 'thyroid', 'bone_health', 'skin', 'eye_health', 'pharmacogenomics', 'hair', 'hearing', 'pain'];
  const sortedCategories = Object.keys(filteredGrouped).sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="space-y-6">
      {/* Summary Dashboard */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="SNPs Loaded" value={summary.snpCount?.toLocaleString()} />
        <StatCard label="Markers Found" value={markers.length} />
        <StatCard label="Categories" value={Object.keys(grouped).length} />
        <StatCard label="Build" value={summary.build} />
      </div>

      {/* Status overview — tappable filter pills */}
      {markers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusFilter === 'all'
                ? 'bg-white/10 text-white border border-white/20'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white'
            }`}
          >
            All ({markers.length})
          </button>
          {STATUS_FILTERS.map(({ key, label, active, inactive }) => statusCounts[key] > 0 && (
            <button
              key={key}
              onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                statusFilter === key ? active : inactive
              }`}
            >
              {statusCounts[key]} {label}
            </button>
          ))}
        </div>
      )}

      {/* Attention Needed — surfaces concerns first */}
      {statusFilter === 'all' && attentionMarkers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wide flex items-center gap-2">
            <AlertTriangle size={14} />
            Attention Needed ({attentionMarkers.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(showAllAttention ? attentionMarkers : attentionMarkers.slice(0, 6)).map(marker => {
              const meta = CATEGORY_META[marker.category] || { emoji: '\u{1F9EC}', label: marker.category };
              return (
                <div key={marker.id} className={`p-3 rounded-lg border ${
                  marker.status === 'major_concern'
                    ? 'border-red-500/30 bg-red-500/5'
                    : 'border-yellow-500/30 bg-yellow-500/5'
                }`}>
                  <div className="flex items-start gap-2">
                    <span className="text-base leading-none mt-0.5">{meta.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{marker.name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                          marker.status === 'major_concern'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {marker.status === 'major_concern' ? 'Major' : 'Concern'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1 line-clamp-2">{marker.description}</p>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-gray-500">
                        <span className="font-mono">{marker.gene}</span>
                        <span className="font-mono">{marker.rsid}</span>
                        {marker.genotype && <span className="px-1 bg-port-card rounded font-mono">{marker.genotype}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {!showAllAttention && attentionMarkers.length > 6 && (
            <button
              onClick={() => setShowAllAttention(true)}
              className="text-xs text-port-accent hover:text-port-accent/80 transition-colors"
            >
              Show all {attentionMarkers.length} markers needing attention
            </button>
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
          {scanning ? <BrailleSpinner /> : <Dna size={14} />}
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

      {/* Category quick-jump (mobile-friendly) */}
      {sortedCategories.length > 5 && (
        <div className="relative" ref={jumpRef}>
          <button
            onClick={() => setJumpOpen(!jumpOpen)}
            className="w-full flex items-center justify-between px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-400 hover:text-white transition-colors"
          >
            <span>Jump to category ({sortedCategories.length})</span>
            <span className="text-xs">{jumpOpen ? '\u25B2' : '\u25BC'}</span>
          </button>
          {jumpOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 z-20 bg-port-card border border-port-border rounded-lg shadow-xl max-h-64 overflow-y-auto">
              {sortedCategories.map(cat => {
                const meta = CATEGORY_META[cat] || { emoji: '\u{1F9EC}', label: cat };
                const catMarkers = filteredGrouped[cat];
                const concerns = catMarkers.filter(m => m.status === 'major_concern' || m.status === 'concern').length;
                return (
                  <button
                    key={cat}
                    onClick={() => {
                      setJumpOpen(false);
                      document.getElementById(`genome-cat-${cat}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-port-border/30 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span>{meta.emoji}</span>
                      <span className="text-gray-300">{meta.label}</span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500">{catMarkers.length}</span>
                      {concerns > 0 && <span className="text-yellow-400">{concerns} !</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Curated Markers by category */}
      {sortedCategories.length > 0 && (
        <div className="space-y-4">
          <div className="columns-1 md:columns-2 xl:columns-3 2xl:columns-4 gap-4 [column-fill:balance]">
            {sortedCategories.map(cat => {
              const meta = CATEGORY_META[cat] || { emoji: '\u{1F9EC}', label: cat, color: 'blue' };
              return (
                <div key={cat} id={`genome-cat-${cat}`} className="break-inside-avoid mb-4 scroll-mt-4">
                  <GenomeCategoryCard
                    category={cat}
                    label={meta.label}
                    emoji={meta.emoji}
                    color={meta.color}
                    markers={filteredGrouped[cat]}
                    defaultExpanded={false}
                    onEditNotes={handleNotesChange}
                    onDeleteMarker={handleDeleteMarker}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {markers.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <Dna className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p>No markers saved yet. Click "Scan Known Markers" to analyze your genome against curated health markers.</p>
        </div>
      )}

      {/* Epigenetic Lifestyle Tracking */}
      <div className="border-t border-port-border pt-6">
        <EpigeneticTracker
          markerCategories={[...new Set(markers.map(m => m.category).filter(Boolean))]}
        />
      </div>

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
              {clinvarSyncing ? <BrailleSpinner /> : <Download size={14} />}
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
                {clinvarScanning ? <BrailleSpinner /> : <Search size={14} />}
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
            <BrailleSpinner />
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
                className="px-2 py-1 rounded bg-port-card border border-port-border text-xs text-gray-400 focus:outline-hidden"
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
                            <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{finding.rsid}</span>
                            <span className="text-white font-medium truncate">{finding.gene}</span>
                            <span className={`px-1.5 py-0.5 rounded text-xs ${sev.bg} ${sev.text} border ${sev.border} shrink-0`}>
                              {sev.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
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
            className="flex-1 max-w-xs px-3 py-2 bg-port-card border border-port-border rounded text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent font-mono"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="flex items-center gap-2 px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-300 hover:text-white hover:border-port-accent transition-colors disabled:opacity-50"
          >
            {searching ? <BrailleSpinner /> : <Search size={14} />}
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
          <BrailleSpinner />
          Saving notes...
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, statusCounts }) {
  return (
    <div className="p-3 rounded bg-port-card border border-port-border">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-lg font-bold text-white mt-1">{value}</div>
      {statusCounts && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {statusCounts.beneficial > 0 && (
            <span className="text-[10px] text-green-400">{statusCounts.beneficial} beneficial</span>
          )}
          {statusCounts.typical > 0 && (
            <span className="text-[10px] text-blue-400">{statusCounts.typical} typical</span>
          )}
          {statusCounts.concern > 0 && (
            <span className="text-[10px] text-yellow-400">{statusCounts.concern} concern</span>
          )}
          {statusCounts.major_concern > 0 && (
            <span className="text-[10px] text-red-400">{statusCounts.major_concern} major</span>
          )}
          {statusCounts.not_found > 0 && (
            <span className="text-[10px] text-gray-500">{statusCounts.not_found} not found</span>
          )}
        </div>
      )}
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
