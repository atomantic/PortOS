/**
 * Curated SNP database with classification logic for known health/longevity markers.
 * Each marker includes rsid, gene info, category, description, and genotype → status rules.
 */

export const MARKER_CATEGORIES = {
  longevity: { label: 'Longevity', icon: 'Sparkles', color: 'purple' },
  cardiovascular: { label: 'Cardiovascular', icon: 'HeartPulse', color: 'rose' },
  iron: { label: 'Iron Metabolism', icon: 'Droplet', color: 'red' },
  methylation: { label: 'Methylation', icon: 'Zap', color: 'blue' },
  nutrient: { label: 'Nutrient Metabolism', icon: 'Apple', color: 'emerald' },
  caffeine: { label: 'Caffeine', icon: 'Coffee', color: 'amber' },
  detox: { label: 'Detoxification', icon: 'Shield', color: 'green' },
  inflammation: { label: 'Inflammation', icon: 'Flame', color: 'orange' },
  tumor_suppression: { label: 'Tumor Suppression', icon: 'ShieldCheck', color: 'indigo' },
  cognitive: { label: 'Cognitive', icon: 'Brain', color: 'cyan' },
  cognitive_decline: { label: 'Cognitive Decline & Dementia Risk', icon: 'BrainCog', color: 'rose' },
  sleep: { label: 'Sleep & Circadian', icon: 'Moon', color: 'violet' },
  athletic: { label: 'Athletic Performance', icon: 'Dumbbell', color: 'sky' },
  skin: { label: 'Skin & UV Response', icon: 'Sun', color: 'yellow' },
  diabetes: { label: 'Blood Sugar & Diabetes', icon: 'Droplets', color: 'amber' },
  gut_health: { label: 'Gut Health & Digestion', icon: 'Salad', color: 'lime' },
  autoimmune: { label: 'Autoimmune Risk', icon: 'ShieldAlert', color: 'pink' },
  thyroid: { label: 'Thyroid & Hormones', icon: 'Activity', color: 'teal' },
  eye_health: { label: 'Eye Health', icon: 'Eye', color: 'sky' },
  mental_health: { label: 'Mental Health', icon: 'Brain', color: 'violet' },
  bone_health: { label: 'Bone Health', icon: 'Bone', color: 'stone' },
  pharmacogenomics: { label: 'Pharmacogenomics', icon: 'Pill', color: 'fuchsia' },
  cancer_breast: { label: 'Breast & Ovarian Cancer', icon: 'Ribbon', color: 'pink' },
  cancer_prostate: { label: 'Prostate Cancer', icon: 'ShieldCheck', color: 'blue' },
  cancer_colorectal: { label: 'Colorectal Cancer', icon: 'ShieldCheck', color: 'amber' },
  cancer_lung: { label: 'Lung Cancer', icon: 'Wind', color: 'slate' },
  cancer_melanoma: { label: 'Melanoma Risk', icon: 'Sun', color: 'stone' },
  cancer_bladder: { label: 'Bladder Cancer', icon: 'ShieldCheck', color: 'zinc' },
  cancer_digestive: { label: 'Digestive Cancer', icon: 'ShieldCheck', color: 'lime' },
  hair: { label: 'Hair Loss', icon: 'Scissors', color: 'zinc' },
  hearing: { label: 'Hearing', icon: 'Ear', color: 'slate' },
  pain: { label: 'Pain Sensitivity', icon: 'Zap', color: 'orange' }
};

/**
 * Curated markers array. Each entry defines:
 * - rsid: The SNP identifier
 * - gene: Gene name
 * - name: Human-readable marker name
 * - category: One of MARKER_CATEGORIES keys
 * - description: What this marker relates to
 * - implications: Map of status → text explaining what that status means
 * - rules: Array of { genotypes: [...], status } for classification
 *
 * The ~116-entry dataset lives in the co-located curatedGenomeMarkers.json
 * (issue #1154 — it was ~2050 lines of hardcoded array literal). Loaded once
 * at module init; the classification logic below stays in this .js. The
 * section dividers the old literal carried (// === LONGEVITY ===, etc.) are
 * dropped — each marker already self-identifies via its `category` field.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
export const CURATED_MARKERS = JSON.parse(
  readFileSync(join(__dir, 'curatedGenomeMarkers.json'), 'utf8'),
);

/**
 * Format raw genotype (e.g., "CT") to display format (e.g., "C/T").
 * Handles already-formatted genotypes, single alleles, and edge cases.
 */
export function formatGenotype(raw) {
  if (!raw || raw === '--' || raw === '00') return null;
  const cleaned = raw.trim().toUpperCase();
  if (cleaned.includes('/')) return cleaned;
  if (cleaned.length === 2) return `${cleaned[0]}/${cleaned[1]}`;
  if (cleaned.length === 1) return `${cleaned}/${cleaned}`;
  return cleaned;
}

/**
 * Classify a genotype against a curated marker's rules.
 * Returns a status string: 'beneficial', 'typical', 'concern', 'major_concern', or 'not_found'.
 */
export function classifyGenotype(marker, genotype) {
  if (!genotype) return 'not_found';
  const formatted = formatGenotype(genotype);
  if (!formatted) return 'not_found';

  for (const rule of marker.rules) {
    if (rule.genotypes.includes(formatted)) {
      return rule.status;
    }
  }
  // If genotype doesn't match any known rule, return typical as fallback
  return 'typical';
}

/**
 * Resolve composite APOE haplotype from rs429358 (ε4) and rs7412 (ε2).
 *
 * APOE alleles are defined by two SNPs on chromosome 19:
 *   ε2: rs429358=T, rs7412=T
 *   ε3: rs429358=T, rs7412=C  (reference/common)
 *   ε4: rs429358=C, rs7412=C
 *
 * The six diploid genotypes and their Alzheimer's risk relative to ε3/ε3:
 *   ε2/ε2 (T/T + T/T) — ~0.6x risk, ~0.7% of population
 *   ε2/ε3 (T/T + C/T) — ~0.6x risk, ~11% of population
 *   ε3/ε3 (T/T + C/C) — 1x baseline, ~60% of population
 *   ε2/ε4 (C/T + C/T) — ~2.6x risk, ~2.6% of population
 *   ε3/ε4 (C/T + C/C) — ~3.2x risk, ~21% of population
 *   ε4/ε4 (C/C + C/C) — ~12x risk, ~2.3% of population
 */
export function resolveApoeHaplotype(rs429358raw, rs7412raw) {
  const rs429358 = formatGenotype(rs429358raw);
  const rs7412 = formatGenotype(rs7412raw);
  if (!rs429358 || !rs7412) return null;

  // Normalize allele order so C/T and T/C both become C/T
  const normalize = (gt) => {
    const [a, b] = gt.split('/');
    return [a, b].sort().join('/');
  };

  const key = `${normalize(rs429358)}|${normalize(rs7412)}`;

  const HAPLOTYPE_MAP = {
    'T/T|T/T': {
      haplotype: 'ε2/ε2',
      frequency: '~0.7%',
      riskMultiplier: '~0.6x',
      status: 'beneficial',
      implication: 'APOE ε2/ε2 — rarest genotype with strongest Alzheimer\'s protection. Both alleles are the neuroprotective ε2 variant. ~0.6x baseline Alzheimer\'s risk. Enhanced amyloid-beta clearance. Note: slightly elevated risk for type III hyperlipoproteinemia — monitor lipid panel periodically.'
    },
    'T/T|C/T': {
      haplotype: 'ε2/ε3',
      frequency: '~11%',
      riskMultiplier: '~0.6x',
      status: 'beneficial',
      implication: 'APOE ε2/ε3 — one protective ε2 allele with the common ε3. ~0.6x Alzheimer\'s risk compared to ε3/ε3 baseline. Favorable amyloid-beta clearance profile. No specific interventions required beyond general brain health.'
    },
    'T/T|C/C': {
      haplotype: 'ε3/ε3',
      frequency: '~60%',
      riskMultiplier: '1x (baseline)',
      status: 'typical',
      implication: 'APOE ε3/ε3 — most common genotype and the reference baseline. Neither increased risk from ε4 nor additional protection from ε2. Standard age-related Alzheimer\'s risk. General neuroprotective habits (exercise, sleep, diet) remain beneficial for everyone.'
    },
    'C/T|C/T': {
      haplotype: 'ε2/ε4',
      frequency: '~2.6%',
      riskMultiplier: '~2.6x',
      status: 'concern',
      implication: 'APOE ε2/ε4 — one risk allele (ε4) and one protective allele (ε2). The ε4 risk partially dominates; overall ~2.6x Alzheimer\'s risk. The ε2 provides some attenuation but does not fully cancel ε4 effects. Recommended: regular cardiovascular exercise, omega-3/DHA supplementation, Mediterranean diet, sleep optimization, and periodic cognitive monitoring.'
    },
    'C/T|C/C': {
      haplotype: 'ε3/ε4',
      frequency: '~21%',
      riskMultiplier: '~3.2x',
      status: 'concern',
      implication: 'APOE ε3/ε4 — one ε4 risk allele with the common ε3. ~3.2x Alzheimer\'s risk vs baseline. Impaired amyloid-beta clearance. Prioritize neuroprotective lifestyle: cardiovascular exercise (150+ min/week), sleep optimization (7-9 hrs), omega-3/DHA (1-2g daily), Mediterranean diet, cognitive engagement, stress management, creatine monohydrate (5g daily), and metabolic health monitoring.'
    },
    'C/C|C/C': {
      haplotype: 'ε4/ε4',
      frequency: '~2.3%',
      riskMultiplier: '~12x',
      status: 'major_concern',
      implication: 'APOE ε4/ε4 — two ε4 risk alleles. ~12x Alzheimer\'s risk vs baseline. Earliest average age of onset among APOE genotypes. Significantly impaired amyloid-beta clearance and cerebral glucose metabolism. Aggressive neuroprotective strategy strongly recommended: regular cardiovascular exercise (150+ min/week), sleep optimization, omega-3/DHA supplementation (2g+ daily), Mediterranean diet, blood pressure and metabolic health management, creatine monohydrate (5g daily), cognitive engagement, and regular cognitive screening starting mid-40s. Consider consulting a genetic counselor.'
    }
  };

  return HAPLOTYPE_MAP[key] || null;
}
