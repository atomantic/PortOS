import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { CURATED_MARKERS, MARKER_CATEGORIES, classifyGenotype, formatGenotype, resolveApoeHaplotype } from '../lib/curatedGenomeMarkers.js';

const GENOME_DIR = PATHS.meatspace;
const RAW_FILE = join(GENOME_DIR, 'genome-raw.txt');
const META_FILE = join(GENOME_DIR, 'genome.json');

// In-memory index: Map<rsid, { chromosome, position, genotype }>
let snpIndex = null;
let indexBuiltAt = 0;
const INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour cache

const DEFAULT_META = {
  uploaded: false,
  uploadedAt: null,
  filename: null,
  snpCount: 0,
  build: null,
  savedMarkers: {},
  lastScanAt: null
};

async function ensureGenomeDir() {
  await ensureDir(GENOME_DIR);
}

async function loadMeta() {
  await ensureGenomeDir();
  const raw = await readFile(META_FILE, 'utf-8').catch(() => null);
  if (!raw) return { ...DEFAULT_META };
  return safeJSONParse(raw, { ...DEFAULT_META });
}

async function saveMeta(meta) {
  await ensureGenomeDir();
  await writeFile(META_FILE, JSON.stringify(meta, null, 2));
}

/**
 * Parse a 23andMe-format TSV genome file into a Map.
 * Format: rsid \t chromosome \t position \t genotype
 * Lines starting with # are comments/headers.
 */
export function parseGenomeFile(content) {
  const index = new Map();
  let build = null;
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Extract build info from header comments
    if (trimmed.startsWith('#')) {
      if (trimmed.includes('build 36')) build = 'Build 36';
      else if (trimmed.includes('build 37')) build = 'Build 37';
      else if (trimmed.includes('build 38') || trimmed.includes('GRCh38')) build = 'Build 38';
      continue;
    }

    const parts = trimmed.split('\t');
    if (parts.length < 4) continue;

    const [rsid, chromosome, position, genotype] = parts;
    if (!rsid.startsWith('rs') && !rsid.startsWith('i')) continue;

    index.set(rsid, {
      chromosome,
      position,
      genotype: genotype.trim()
    });
  }

  return { index, build };
}

/**
 * Build or return the in-memory SNP index from the raw genome file.
 * Cached for INDEX_TTL_MS (1 hour).
 */
export async function getSnpIndex() {
  if (snpIndex && (Date.now() - indexBuiltAt < INDEX_TTL_MS)) {
    return snpIndex;
  }

  const content = await readFile(RAW_FILE, 'utf-8').catch(() => null);
  if (!content) {
    snpIndex = null;
    return null;
  }

  const { index } = parseGenomeFile(content);
  snpIndex = index;
  indexBuiltAt = Date.now();
  console.log(`🧬 Genome index built: ${index.size} SNPs cached`);
  return index;
}

/**
 * Upload and store a genome file.
 * Validates TSV format, saves raw file, builds index, saves metadata.
 */
export async function uploadGenome(content, filename) {
  await ensureGenomeDir();

  const { index, build } = parseGenomeFile(content);
  if (index.size < 100) {
    return { error: 'File does not appear to be a valid 23andMe genome export (too few SNPs found)' };
  }

  // Save raw file
  await writeFile(RAW_FILE, content);

  // Cache the index
  snpIndex = index;
  indexBuiltAt = Date.now();

  // Save metadata
  const meta = await loadMeta();
  meta.uploaded = true;
  meta.uploadedAt = new Date().toISOString();
  meta.filename = filename;
  meta.snpCount = index.size;
  meta.build = build || 'Unknown';
  await saveMeta(meta);

  console.log(`🧬 Genome uploaded: ${filename} — ${index.size} SNPs, ${build || 'unknown build'}`);

  return {
    snpCount: index.size,
    build: build || 'Unknown',
    filename
  };
}

/**
 * Get genome summary: upload status, stats, and saved marker counts.
 */
export async function getGenomeSummary() {
  const meta = await loadMeta();
  if (!meta.uploaded) {
    return { uploaded: false };
  }

  const savedMarkers = Object.values(meta.savedMarkers || {});
  const statusCounts = { beneficial: 0, typical: 0, concern: 0, major_concern: 0, not_found: 0 };
  for (const marker of savedMarkers) {
    if (statusCounts[marker.status] !== undefined) {
      statusCounts[marker.status]++;
    }
  }

  return {
    uploaded: true,
    uploadedAt: meta.uploadedAt,
    filename: meta.filename,
    snpCount: meta.snpCount,
    build: meta.build,
    markerCount: savedMarkers.length,
    statusCounts,
    lastScanAt: meta.lastScanAt,
    savedMarkers: meta.savedMarkers
  };
}

/**
 * Scan all curated markers against the genome, classify genotypes, and auto-save results.
 */
export async function scanCuratedMarkers() {
  const index = await getSnpIndex();
  if (!index) {
    return { error: 'No genome data uploaded. Upload a genome file first.' };
  }

  const meta = await loadMeta();
  const results = [];

  for (const marker of CURATED_MARKERS) {
    const snp = index.get(marker.rsid);
    const genotype = snp ? formatGenotype(snp.genotype) : null;
    const status = snp ? classifyGenotype(marker, snp.genotype) : 'not_found';
    const implication = marker.implications[status] || '';

    // Check if already saved (by rsid match)
    const existingEntry = Object.entries(meta.savedMarkers || {}).find(([, m]) => m.rsid === marker.rsid);
    const id = existingEntry ? existingEntry[0] : randomUUID();

    const savedMarker = {
      rsid: marker.rsid,
      genotype,
      chromosome: snp?.chromosome || '',
      position: snp?.position || '',
      status,
      category: marker.category,
      gene: marker.gene,
      name: marker.name,
      description: marker.description,
      implications: implication,
      notes: existingEntry ? existingEntry[1].notes : '',
      references: existingEntry ? existingEntry[1].references : [],
      savedAt: existingEntry ? existingEntry[1].savedAt : new Date().toISOString()
    };

    meta.savedMarkers[id] = savedMarker;
    results.push({ id, ...savedMarker });
  }

  // Resolve composite APOE haplotype from rs429358 (ε4) + rs7412 (ε2)
  const rs429358snp = index.get('rs429358');
  const rs7412snp = index.get('rs7412');
  if (rs429358snp && rs7412snp) {
    const apoeResult = resolveApoeHaplotype(rs429358snp.genotype, rs7412snp.genotype);
    if (apoeResult) {
      const existingApoe = Object.entries(meta.savedMarkers || {}).find(([, m]) => m.rsid === 'apoe_haplotype');
      const apoeId = existingApoe ? existingApoe[0] : randomUUID();

      const apoeMarker = {
        rsid: 'apoe_haplotype',
        genotype: apoeResult.haplotype,
        chromosome: '19',
        position: '',
        status: apoeResult.status,
        category: 'cognitive_decline',
        gene: 'APOE',
        name: `APOE Haplotype: ${apoeResult.haplotype}`,
        description: `Composite APOE genotype determined from rs429358 (ε4) and rs7412 (ε2). Population frequency: ${apoeResult.frequency}. Alzheimer's risk: ${apoeResult.riskMultiplier} vs ε3/ε3 baseline.`,
        implications: apoeResult.implication,
        notes: existingApoe ? existingApoe[1].notes : '',
        references: existingApoe ? existingApoe[1].references : [],
        savedAt: existingApoe ? existingApoe[1].savedAt : new Date().toISOString()
      };

      meta.savedMarkers[apoeId] = apoeMarker;
      results.push({ id: apoeId, ...apoeMarker });
      console.log(`🧬 APOE haplotype resolved: ${apoeResult.haplotype} (${apoeResult.riskMultiplier} risk)`);
    }
  }

  meta.lastScanAt = new Date().toISOString();
  await saveMeta(meta);

  console.log(`🧬 Curated scan complete: ${results.length} markers classified`);

  return {
    markers: results,
    categories: MARKER_CATEGORIES,
    scannedAt: meta.lastScanAt
  };
}

/**
 * Search for a single SNP by rsid in the genome data.
 */
export async function searchSNP(rsid) {
  const index = await getSnpIndex();
  if (!index) {
    return { found: false, error: 'No genome data uploaded' };
  }

  const snp = index.get(rsid);
  if (!snp) {
    return { found: false, rsid };
  }

  // Check if this SNP is in our curated list
  const curatedMarker = CURATED_MARKERS.find(m => m.rsid === rsid);
  const genotype = formatGenotype(snp.genotype);

  return {
    found: true,
    rsid,
    chromosome: snp.chromosome,
    position: snp.position,
    genotype,
    curated: !!curatedMarker,
    gene: curatedMarker?.gene || null,
    name: curatedMarker?.name || null,
    category: curatedMarker?.category || null,
    status: curatedMarker ? classifyGenotype(curatedMarker, snp.genotype) : null,
    description: curatedMarker?.description || null,
    implications: curatedMarker ? (curatedMarker.implications[classifyGenotype(curatedMarker, snp.genotype)] || '') : null
  };
}

/**
 * Save a custom marker to the genome metadata.
 */
export async function saveMarker(data) {
  const meta = await loadMeta();
  const id = randomUUID();

  // Look up genotype from raw data if not provided
  let genotype = data.genotype || null;
  let chromosome = data.chromosome || '';
  let position = data.position || '';

  if (!genotype) {
    const index = await getSnpIndex();
    if (index) {
      const snp = index.get(data.rsid);
      if (snp) {
        genotype = formatGenotype(snp.genotype);
        chromosome = snp.chromosome;
        position = snp.position;
      }
    }
  }

  const marker = {
    rsid: data.rsid,
    genotype,
    chromosome,
    position,
    status: data.status || 'typical',
    category: data.category,
    gene: data.gene || '',
    name: data.name,
    description: data.description || '',
    implications: data.implications || '',
    notes: data.notes || '',
    references: data.references || [],
    savedAt: new Date().toISOString()
  };

  meta.savedMarkers[id] = marker;
  await saveMeta(meta);
  console.log(`🧬 Marker saved: ${data.rsid} (${data.name})`);

  return { id, ...marker };
}

/**
 * Update notes on a saved marker.
 */
export async function updateMarkerNotes(id, notes) {
  const meta = await loadMeta();
  if (!meta.savedMarkers[id]) {
    return { error: 'Marker not found' };
  }

  meta.savedMarkers[id].notes = notes;
  await saveMeta(meta);
  console.log(`🧬 Marker notes updated: ${meta.savedMarkers[id].rsid}`);

  return { id, ...meta.savedMarkers[id] };
}

/**
 * Delete a saved marker.
 */
export async function deleteMarker(id) {
  const meta = await loadMeta();
  if (!meta.savedMarkers[id]) {
    return { error: 'Marker not found' };
  }

  const rsid = meta.savedMarkers[id].rsid;
  delete meta.savedMarkers[id];
  await saveMeta(meta);
  console.log(`🧬 Marker deleted: ${rsid}`);

  return { success: true };
}

/**
 * Delete all genome data: raw file, metadata, and clear cache.
 */
export async function deleteGenome() {
  await unlink(RAW_FILE).catch(() => {});
  await unlink(META_FILE).catch(() => {});
  snpIndex = null;
  indexBuiltAt = 0;
  console.log('🧬 Genome data deleted');

  return { success: true };
}
