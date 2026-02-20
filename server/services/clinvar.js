import { createWriteStream, createReadStream } from 'fs';
import { readFile, writeFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import { PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';

const GENOME_DIR = PATHS.digitalTwin;
const CLINVAR_GZ = join(GENOME_DIR, 'clinvar-raw.txt.gz');
const CLINVAR_INDEX = join(GENOME_DIR, 'clinvar-index.json');
const CLINVAR_META = join(GENOME_DIR, 'clinvar-meta.json');

const CLINVAR_URL = 'https://ftp.ncbi.nlm.nih.gov/pub/clinvar/tab_delimited/variant_summary.txt.gz';

// ClinVar significance levels we care about (skip benign/uncertain — too noisy)
const ACTIONABLE_SIGNIFICANCE = new Set([
  'pathogenic',
  'likely pathogenic',
  'pathogenic/likely pathogenic',
  'risk factor',
  'drug response',
  'association',
  'protective',
  'affects',
  'pathogenic, risk factor',
  'likely pathogenic, risk factor'
]);

// Map review status to star rating (ClinVar's official star system)
const REVIEW_STARS = {
  'practice guideline': 4,
  'reviewed by expert panel': 3,
  'criteria provided, multiple submitters, no conflicts': 2,
  'criteria provided, conflicting classifications': 1,
  'criteria provided, single submitter': 1
};

// In-memory index: Map<rsid, array of annotations>
let clinvarIndex = null;

/**
 * Get ClinVar sync status and stats.
 */
export async function getClinvarStatus() {
  await ensureDir(GENOME_DIR);
  const meta = await readFile(CLINVAR_META, 'utf-8').catch(() => null);
  if (!meta) return { synced: false };
  return JSON.parse(meta);
}

/**
 * Download ClinVar variant_summary.txt.gz from NCBI FTP.
 * Returns the path to the downloaded file.
 */
async function downloadClinvar(onProgress) {
  await ensureDir(GENOME_DIR);

  console.log('🧬 ClinVar: downloading variant_summary.txt.gz from NCBI...');
  onProgress?.('Downloading ClinVar database from NCBI...');

  const response = await fetch(CLINVAR_URL);
  if (!response.ok) {
    return { error: `Download failed: HTTP ${response.status}` };
  }

  const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
  const writer = createWriteStream(CLINVAR_GZ);
  const reader = response.body.getReader();

  let downloaded = 0;
  const writable = new WritableStream({
    write(chunk) {
      downloaded += chunk.length;
      writer.write(chunk);
      if (totalBytes > 0) {
        const pct = Math.round((downloaded / totalBytes) * 100);
        if (pct % 10 === 0) onProgress?.(`Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
      }
    },
    close() {
      writer.end();
    }
  });

  await reader.read().then(function pump({ done, value }) {
    if (done) {
      writer.end();
      return;
    }
    downloaded += value.length;
    writer.write(value);
    if (totalBytes > 0) {
      const pct = Math.round((downloaded / totalBytes) * 100);
      if (pct % 10 === 0) onProgress?.(`Downloading... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB)`);
    }
    return reader.read().then(pump);
  });

  // Wait for writer to finish
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const fileInfo = await stat(CLINVAR_GZ);
  console.log(`🧬 ClinVar: downloaded ${(fileInfo.size / 1024 / 1024).toFixed(1)}MB`);

  return { path: CLINVAR_GZ, size: fileInfo.size };
}

/**
 * Parse the ClinVar gzipped TSV and build a filtered index.
 * Streams the file to handle large sizes without loading into memory.
 */
async function buildClinvarIndex(onProgress) {
  console.log('🧬 ClinVar: parsing and filtering variant_summary.txt.gz...');
  onProgress?.('Parsing ClinVar data (this may take a minute)...');

  const index = {};
  let lineCount = 0;
  let matchCount = 0;
  let headerColumns = null;

  await new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const fileStream = createReadStream(CLINVAR_GZ);
    const rl = createInterface({ input: fileStream.pipe(gunzip) });

    rl.on('line', (line) => {
      lineCount++;

      // Parse header — strip only the leading '#' from the line (preserves '#' within column names like 'RS# (dbSNP)')
      if (lineCount === 1) {
        const headerLine = line.startsWith('#') ? line.substring(1) : line;
        headerColumns = headerLine.split('\t').reduce((acc, col, i) => {
          acc[col.trim()] = i;
          return acc;
        }, {});
        return;
      }

      const cols = line.split('\t');

      // Must have an rsid
      const rsid = cols[headerColumns['RS# (dbSNP)']]?.trim();
      if (!rsid || rsid === '-1' || rsid === '-') return;
      const rsidFormatted = rsid.startsWith('rs') ? rsid : `rs${rsid}`;

      // Must be a single nucleotide variant (matches 23andMe data)
      const varType = cols[headerColumns['Type']]?.trim().toLowerCase();
      if (varType !== 'single nucleotide variant') return;

      // Must have actionable clinical significance
      const rawSignificance = cols[headerColumns['ClinicalSignificance']]?.trim() || '';
      const significanceLower = rawSignificance.toLowerCase();

      // Check if any actionable significance is present
      const isActionable = [...ACTIONABLE_SIGNIFICANCE].some(s => significanceLower.includes(s));
      if (!isActionable) return;

      // Extract data
      const gene = cols[headerColumns['GeneSymbol']]?.trim() || '';
      const phenotype = cols[headerColumns['PhenotypeList']]?.trim() || '';
      const reviewStatus = cols[headerColumns['ReviewStatus']]?.trim() || '';
      const assembly = cols[headerColumns['Assembly']]?.trim() || '';
      const origin = cols[headerColumns['Origin']]?.trim() || '';

      // Prefer GRCh37 (Build 37, standard for 23andMe v4/v5) or GRCh38
      if (assembly && assembly !== 'GRCh37' && assembly !== 'GRCh38') return;

      // Only germline variants (not somatic)
      if (origin && !origin.includes('germline') && origin !== 'not provided') return;

      const stars = REVIEW_STARS[reviewStatus] || 0;

      // Determine our severity level
      let severity = 'risk_factor';
      if (significanceLower.includes('pathogenic')) severity = 'pathogenic';
      else if (significanceLower.includes('protective')) severity = 'protective';
      else if (significanceLower.includes('drug response')) severity = 'drug_response';
      else if (significanceLower.includes('association') || significanceLower.includes('risk factor')) severity = 'risk_factor';

      // Clean up phenotype — split on semicolons, deduplicate
      const conditions = [...new Set(
        phenotype.split(/[;|]/)
          .map(s => s.trim())
          .filter(s => s && s !== 'not specified' && s !== 'not provided')
      )].slice(0, 5); // Cap at 5 conditions

      // Store entry — group by rsid (some SNPs have multiple ClinVar entries)
      if (!index[rsidFormatted]) {
        index[rsidFormatted] = {
          gene,
          entries: []
        };
      }

      // Avoid duplicate condition entries
      const isDupe = index[rsidFormatted].entries.some(
        e => e.significance === rawSignificance && e.conditions.join() === conditions.join()
      );
      if (isDupe) return;

      index[rsidFormatted].entries.push({
        significance: rawSignificance,
        severity,
        conditions,
        reviewStatus,
        stars,
        assembly
      });

      matchCount++;

      if (matchCount % 5000 === 0) {
        onProgress?.(`Processed ${lineCount.toLocaleString()} lines, found ${matchCount.toLocaleString()} actionable variants...`);
      }
    });

    rl.on('close', resolve);
    rl.on('error', reject);
    gunzip.on('error', reject);
    fileStream.on('error', reject);
  });

  // Deduplicate: keep highest-star entry per rsid, consolidate conditions
  const compactIndex = {};
  for (const [rsid, data] of Object.entries(index)) {
    // Sort entries by severity (pathogenic first) then stars
    const severityOrder = { pathogenic: 0, drug_response: 1, risk_factor: 2, protective: 3 };
    data.entries.sort((a, b) => {
      const sDiff = (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
      return sDiff !== 0 ? sDiff : b.stars - a.stars;
    });

    const topEntry = data.entries[0];
    const allConditions = [...new Set(data.entries.flatMap(e => e.conditions))].slice(0, 8);

    compactIndex[rsid] = {
      g: data.gene,                    // gene
      s: topEntry.severity,            // severity
      c: allConditions,                // conditions
      r: topEntry.stars,               // review stars (0-4)
      x: topEntry.significance,        // raw significance text
      n: data.entries.length            // number of ClinVar submissions
    };
  }

  console.log(`🧬 ClinVar: ${Object.keys(compactIndex).length} unique rsids with actionable significance from ${lineCount.toLocaleString()} lines`);

  return compactIndex;
}

/**
 * Full sync: download ClinVar, parse, build index, save.
 */
export async function syncClinvar(onProgress) {
  const downloadResult = await downloadClinvar(onProgress);
  if (downloadResult.error) return downloadResult;

  onProgress?.('Building search index...');
  const index = await buildClinvarIndex(onProgress);

  // Save compact index
  const indexJson = JSON.stringify(index);
  await writeFile(CLINVAR_INDEX, indexJson);

  // Save metadata
  const meta = {
    synced: true,
    syncedAt: new Date().toISOString(),
    variantCount: Object.keys(index).length,
    downloadSize: downloadResult.size,
    indexSize: Buffer.byteLength(indexJson)
  };
  await writeFile(CLINVAR_META, JSON.stringify(meta, null, 2));

  // Clean up the raw gz file to save disk space
  await unlink(CLINVAR_GZ).catch(() => {});

  console.log(`🧬 ClinVar sync complete: ${meta.variantCount.toLocaleString()} variants indexed (${(meta.indexSize / 1024 / 1024).toFixed(1)}MB)`);

  return meta;
}

/**
 * Load the ClinVar index into memory (lazy, cached).
 */
async function loadClinvarIndex() {
  if (clinvarIndex) return clinvarIndex;

  const raw = await readFile(CLINVAR_INDEX, 'utf-8').catch(() => null);
  if (!raw) return null;

  clinvarIndex = safeJSONParse(raw, null, { logError: true, context: 'ClinVar index' });
  if (!clinvarIndex) return null;
  console.log(`🧬 ClinVar index loaded: ${Object.keys(clinvarIndex).length.toLocaleString()} variants`);
  return clinvarIndex;
}

/**
 * Invalidate cached index (after re-sync).
 */
export function invalidateClinvarCache() {
  clinvarIndex = null;
}

// Severity to our status mapping
const SEVERITY_STATUS = {
  pathogenic: 'major_concern',
  risk_factor: 'concern',
  drug_response: 'concern',
  association: 'concern',
  protective: 'beneficial'
};

/**
 * Scan a genome's SNPs against the ClinVar index.
 * Returns grouped findings sorted by severity.
 */
export async function scanClinvar(snpIndex) {
  const cvIndex = await loadClinvarIndex();
  if (!cvIndex) return { error: 'ClinVar database not synced. Click "Sync ClinVar" first.' };
  if (!snpIndex) return { error: 'No genome data uploaded.' };

  const findings = [];

  for (const [rsid, snpData] of snpIndex) {
    const cv = cvIndex[rsid];
    if (!cv) continue;

    findings.push({
      rsid,
      genotype: snpData.genotype,
      chromosome: snpData.chromosome,
      position: snpData.position,
      gene: cv.g,
      severity: cv.s,
      status: SEVERITY_STATUS[cv.s] || 'concern',
      significance: cv.x,
      conditions: cv.c,
      reviewStars: cv.r,
      submissions: cv.n
    });
  }

  // Sort: pathogenic first, then by review stars (higher = more reliable)
  const severityOrder = { pathogenic: 0, drug_response: 1, risk_factor: 2, protective: 3 };
  findings.sort((a, b) => {
    const sDiff = (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
    return sDiff !== 0 ? sDiff : b.reviewStars - a.reviewStars;
  });

  console.log(`🧬 ClinVar scan: ${findings.length} actionable variants found in genome`);

  return {
    findings,
    totalMatched: findings.length,
    bySeverity: {
      pathogenic: findings.filter(f => f.severity === 'pathogenic').length,
      drug_response: findings.filter(f => f.severity === 'drug_response').length,
      risk_factor: findings.filter(f => f.severity === 'risk_factor').length,
      protective: findings.filter(f => f.severity === 'protective').length
    }
  };
}

/**
 * Delete ClinVar data (index + meta + raw).
 */
export async function deleteClinvar() {
  await unlink(CLINVAR_GZ).catch(() => {});
  await unlink(CLINVAR_INDEX).catch(() => {});
  await unlink(CLINVAR_META).catch(() => {});
  clinvarIndex = null;
  console.log('🧬 ClinVar data deleted');
  return { success: true };
}
