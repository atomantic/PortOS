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
 */
export const CURATED_MARKERS = [
  // === LONGEVITY ===
  {
    rsid: 'rs2802292',
    gene: 'FOXO3A',
    name: 'Longevity / FOXO3A',
    category: 'longevity',
    description: 'FOXO3A is one of the most replicated longevity-associated genes. The G allele is linked to exceptional lifespan across multiple populations.',
    implications: {
      beneficial: 'Carries the longevity-associated G/G genotype. Associated with improved stress resistance and cellular maintenance.',
      typical: 'Heterozygous carrier. Partial longevity association.',
      concern: 'Does not carry the longevity-associated allele.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs2229765',
    gene: 'IGF1R',
    name: 'Insulin-like Growth Factor Receptor',
    category: 'longevity',
    description: 'IGF1R variants affect growth factor signaling. Reduced IGF-1 signaling is associated with extended lifespan in model organisms and centenarian studies.',
    implications: {
      beneficial: 'Genotype associated with favorable IGF-1 signaling for longevity.',
      typical: 'Intermediate IGF-1 receptor activity.',
      concern: 'Standard IGF-1 signaling — no longevity advantage from this variant.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs5882',
    gene: 'CETP',
    name: 'HDL Cholesterol / CETP',
    category: 'longevity',
    description: 'CETP transfers cholesterol between lipoproteins. The Val (G) allele is associated with higher HDL levels and longevity in Ashkenazi centenarian studies.',
    implications: {
      beneficial: 'Val/Val genotype — associated with higher HDL cholesterol and longevity.',
      typical: 'Heterozygous — intermediate HDL effect.',
      concern: 'Ile/Ile genotype — standard CETP activity.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs12366',
    gene: 'IPMK',
    name: 'Inositol Polyphosphate Multikinase',
    category: 'longevity',
    description: 'IPMK is involved in cellular signaling and nutrient sensing pathways. Variants may influence metabolic longevity pathways.',
    implications: {
      beneficial: 'Genotype associated with favorable metabolic signaling.',
      typical: 'Intermediate variant — standard metabolic signaling.',
      concern: 'No longevity-associated variant detected.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1042522',
    gene: 'TP53',
    name: 'Tumor Protein p53 (Pro72Arg)',
    category: 'tumor_suppression',
    description: 'TP53 is the guardian of the genome. The Pro72Arg polymorphism affects apoptotic efficiency. Arg (G) induces apoptosis more efficiently, while Pro (C) favors cell cycle arrest and DNA repair.',
    implications: {
      beneficial: 'Arg/Arg — more efficient apoptotic response to DNA damage.',
      typical: 'Heterozygous — balanced apoptosis and repair capacity.',
      concern: 'Pro/Pro — favors repair over apoptosis, which may affect tumor suppression efficiency.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === IRON METABOLISM ===
  {
    rsid: 'rs1799945',
    gene: 'HFE (H63D)',
    name: 'Hereditary Hemochromatosis H63D',
    category: 'iron',
    description: 'H63D is a common HFE variant associated with mild iron overload. Homozygous carriers have moderately increased iron absorption.',
    implications: {
      beneficial: 'No H63D variant — normal iron regulation.',
      concern: 'Heterozygous carrier — mildly increased iron absorption. Monitor ferritin levels.',
      major_concern: 'Homozygous H63D — moderate hemochromatosis risk. Regular iron panel monitoring recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'concern' },
      { genotypes: ['G/G'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs1800562',
    gene: 'HFE (C282Y)',
    name: 'Hereditary Hemochromatosis C282Y',
    category: 'iron',
    description: 'C282Y is the primary HFE mutation for hereditary hemochromatosis. Homozygous carriers have significantly increased iron absorption and organ damage risk.',
    implications: {
      beneficial: 'No C282Y variant — normal iron regulation.',
      concern: 'Heterozygous carrier — mild hemochromatosis risk. Compound heterozygosity with H63D increases risk.',
      major_concern: 'Homozygous C282Y — high hereditary hemochromatosis risk. Regular phlebotomy and monitoring essential.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'concern' },
      { genotypes: ['A/A'], status: 'major_concern' }
    ]
  },

  // === METHYLATION ===
  {
    rsid: 'rs1801133',
    gene: 'MTHFR',
    name: 'MTHFR C677T',
    category: 'methylation',
    description: 'MTHFR C677T affects folate metabolism and homocysteine levels. The T variant reduces enzyme activity, impacting methylation capacity.',
    implications: {
      beneficial: 'C/C — normal MTHFR enzyme activity (~100%). Standard folate metabolism.',
      concern: 'C/T heterozygous — ~65% enzyme activity. Consider methylfolate supplementation.',
      major_concern: 'T/T homozygous — ~30% enzyme activity. Elevated homocysteine risk. Methylfolate supplementation recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'concern' },
      { genotypes: ['T/T'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs1801131',
    gene: 'MTHFR',
    name: 'MTHFR A1298C',
    category: 'methylation',
    description: 'MTHFR A1298C is a second common variant affecting methylation. Less impactful alone than C677T, but compound heterozygosity (one copy of each) can significantly reduce function.',
    implications: {
      beneficial: 'T/T — normal MTHFR activity at this position.',
      concern: 'Heterozygous — mildly reduced activity. Check for compound heterozygosity with C677T.',
      major_concern: 'Homozygous variant — reduced activity at both MTHFR positions increases methylation impact.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'concern' },
      { genotypes: ['G/G'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs4680',
    gene: 'COMT',
    name: 'COMT Val158Met',
    category: 'methylation',
    description: 'COMT metabolizes catecholamines (dopamine, norepinephrine) in the prefrontal cortex. Val (G) = fast breakdown ("Warrior" — stress-resilient), Met (A) = slow breakdown ("Worrier" — better focus in calm). Neither is inherently better — context matters.',
    implications: {
      beneficial: 'A/G heterozygous — balanced COMT activity. Often considered optimal for both focus and stress resilience.',
      typical: 'G/G Val/Val — fast COMT. Lower dopamine baseline. Better stress resilience, may need more stimulation for focus.',
      concern: 'A/A Met/Met — slow COMT. Higher dopamine baseline. Better focus under calm conditions, but more stress-sensitive.'
    },
    rules: [
      { genotypes: ['A/G', 'G/A'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs819147',
    gene: 'AHCY',
    name: 'S-Adenosylhomocysteine Hydrolase',
    category: 'methylation',
    description: 'AHCY converts S-adenosylhomocysteine to homocysteine in the methylation cycle. Variants can affect methylation efficiency and homocysteine clearance.',
    implications: {
      beneficial: 'Normal AHCY function — efficient methylation cycle turnover.',
      typical: 'Heterozygous — mildly altered AHCY activity.',
      concern: 'Homozygous variant — may affect methylation cycle efficiency.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === CAFFEINE ===
  {
    rsid: 'rs73598374',
    gene: 'ADA',
    name: 'Caffeine / Adenosine Processing',
    category: 'caffeine',
    description: 'ADA (adenosine deaminase) breaks down adenosine, the molecule caffeine blocks. Variants affect caffeine sensitivity and sleep quality after caffeine consumption.',
    implications: {
      beneficial: 'C/C — normal adenosine processing. Standard caffeine response.',
      concern: 'C/T — altered adenosine metabolism. May be more sensitive to caffeine effects on sleep.',
      major_concern: 'T/T — significantly altered adenosine processing. Likely high caffeine sensitivity.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'concern' },
      { genotypes: ['T/T'], status: 'major_concern' }
    ]
  },

  // === DETOXIFICATION ===
  {
    rsid: 'rs3745274',
    gene: 'CYP2B6',
    name: 'Drug Metabolism / CYP2B6',
    category: 'detox',
    description: 'CYP2B6 metabolizes many drugs including efavirenz, bupropion, and cyclophosphamide. Variants affect metabolism speed and drug response.',
    implications: {
      beneficial: 'G/G — normal (extensive) metabolizer. Standard drug metabolism.',
      typical: 'G/T — intermediate metabolizer. May need dose adjustments for some medications.',
      concern: 'T/T — poor metabolizer. Significantly altered drug metabolism. Pharmacogenomic testing recommended before certain medications.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4880',
    gene: 'SOD2',
    name: 'Superoxide Dismutase / Oxidative Stress',
    category: 'detox',
    description: 'SOD2 (MnSOD) neutralizes superoxide radicals in mitochondria. The Ala16Val polymorphism affects mitochondrial targeting and antioxidant capacity.',
    implications: {
      beneficial: 'A/G heterozygous — balanced SOD2 activity. Heterozygote advantage documented in some studies.',
      typical: 'G/G Ala/Ala — efficient mitochondrial import. Good baseline antioxidant capacity.',
      concern: 'A/A Val/Val — less efficient mitochondrial targeting. May benefit from additional antioxidant support.'
    },
    rules: [
      { genotypes: ['A/G', 'G/A'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === INFLAMMATION ===
  {
    rsid: 'rs1800795',
    gene: 'IL-6',
    name: 'Interleukin-6 Inflammation',
    category: 'inflammation',
    description: 'IL-6 is a key inflammatory cytokine. The -174 G/C promoter polymorphism affects IL-6 expression levels and systemic inflammation.',
    implications: {
      beneficial: 'G/G — lower baseline IL-6 levels. Reduced systemic inflammation.',
      typical: 'G/C — intermediate IL-6 expression.',
      concern: 'C/C — higher baseline IL-6 levels. Associated with increased inflammatory response and cardiovascular risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/C', 'C/G'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1800629',
    gene: 'TNF-alpha',
    name: 'TNF-alpha Inflammatory Response',
    category: 'inflammation',
    description: 'TNF-alpha is a master regulator of the inflammatory cascade. The -308 G>A promoter variant increases TNF-alpha production, raising risk for autoimmune and inflammatory conditions.',
    implications: {
      beneficial: 'G/G — normal TNF-alpha expression. Standard inflammatory baseline.',
      typical: 'G/A — moderately elevated TNF-alpha. Slightly increased inflammatory tendency.',
      concern: 'A/A — significantly elevated TNF-alpha production. Higher risk for rheumatoid arthritis, inflammatory bowel disease, and other autoimmune conditions.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === CARDIOVASCULAR ===
  {
    rsid: 'rs6025',
    gene: 'F5 (Factor V)',
    name: 'Factor V Leiden Thrombophilia',
    category: 'cardiovascular',
    description: 'Factor V Leiden is the most common inherited thrombophilia. The variant makes Factor V resistant to inactivation by Protein C, increasing venous clot risk 5-80x depending on zygosity.',
    implications: {
      beneficial: 'C/C — no Factor V Leiden variant. Normal clotting regulation.',
      concern: 'C/T — heterozygous carrier. 5-10x increased risk of venous thromboembolism. Discuss with physician before surgery, hormonal contraceptives, or long flights.',
      major_concern: 'T/T — homozygous Factor V Leiden. 50-100x increased clotting risk. Anticoagulation management strongly recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'concern' },
      { genotypes: ['T/T'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs1333049',
    gene: '9p21.3',
    name: 'Coronary Artery Disease Risk (9p21)',
    category: 'cardiovascular',
    description: 'The 9p21.3 locus is the strongest common genetic risk factor for coronary artery disease, replicated in >100,000 individuals across multiple ethnicities. It affects vascular cell proliferation near CDKN2A/B tumor suppressors.',
    implications: {
      beneficial: 'G/G — lower genetic risk for coronary artery disease.',
      typical: 'C/G — average population risk. One copy of risk allele.',
      concern: 'C/C — elevated genetic risk (~1.6x) for coronary artery disease. Extra emphasis on modifiable risk factors (diet, exercise, lipids).'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs10455872',
    gene: 'LPA',
    name: 'Lipoprotein(a) Levels',
    category: 'cardiovascular',
    description: 'Lipoprotein(a) is a causal, independent cardiovascular risk factor not lowered by statins. This LPA variant strongly predicts elevated Lp(a) levels. High Lp(a) increases risk of heart attack, stroke, and aortic stenosis.',
    implications: {
      beneficial: 'A/A — predicted normal Lp(a) levels.',
      concern: 'A/G — likely elevated Lp(a). Request a blood Lp(a) measurement to confirm. Consider PCSK9 inhibitors or emerging therapies if confirmed high.',
      major_concern: 'G/G — strongly elevated Lp(a) predicted. High cardiovascular risk independent of LDL. Lp(a) blood test and cardiology consultation recommended.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'concern' },
      { genotypes: ['G/G'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs1799963',
    gene: 'F2 (Prothrombin)',
    name: 'Prothrombin G20210A Thrombophilia',
    category: 'cardiovascular',
    description: 'The prothrombin G20210A mutation increases prothrombin production, raising venous thromboembolism risk 2-5x. Second most common inherited thrombophilia after Factor V Leiden.',
    implications: {
      beneficial: 'G/G — normal prothrombin levels. No inherited thrombophilia from this variant.',
      concern: 'G/A — heterozygous carrier. ~3x increased venous clot risk. Combined with Factor V Leiden or oral contraceptives, risk compounds significantly.',
      major_concern: 'A/A — homozygous variant. Substantially elevated clotting risk. Hematology consultation recommended.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'concern' },
      { genotypes: ['A/A'], status: 'major_concern' }
    ]
  },

  // === NUTRIENT METABOLISM ===
  {
    rsid: 'rs2228570',
    gene: 'VDR',
    name: 'Vitamin D Receptor (FokI)',
    category: 'nutrient',
    description: 'The VDR FokI polymorphism affects Vitamin D receptor length and activity. The shorter "F" form (T allele on + strand) is more transcriptionally active, influencing calcium absorption, bone density, and immune function.',
    implications: {
      beneficial: 'T/T — more active VDR. Better vitamin D utilization at a given blood level.',
      typical: 'C/T — intermediate VDR activity.',
      concern: 'C/C — less active VDR. May require higher vitamin D levels to achieve the same biological effect. Consider testing 25(OH)D levels.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs7501331',
    gene: 'BCMO1',
    name: 'Beta-Carotene to Vitamin A Conversion',
    category: 'nutrient',
    description: 'BCMO1 converts beta-carotene (from plants) into retinal (active Vitamin A). Variants reduce conversion efficiency by 32-69%, meaning plant-based beta-carotene may not meet Vitamin A needs.',
    implications: {
      beneficial: 'C/C — normal beta-carotene conversion. Plant sources can meet Vitamin A needs.',
      concern: 'C/T — ~32% reduced conversion. May need more preformed Vitamin A (retinol) from animal sources or supplements.',
      major_concern: 'T/T — ~69% reduced conversion. Significantly impaired beta-carotene utilization. Preformed Vitamin A sources recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'concern' },
      { genotypes: ['T/T'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs602662',
    gene: 'FUT2',
    name: 'Vitamin B12 Absorption (Secretor Status)',
    category: 'nutrient',
    description: 'FUT2 determines "secretor status" — whether you secrete blood type antigens into mucus and saliva. Non-secretors have altered gut microbiome composition and reduced Vitamin B12 absorption.',
    implications: {
      beneficial: 'G/G — secretor. Normal B12 absorption and gut microbiome interaction.',
      typical: 'A/G — secretor (one functional copy sufficient). Generally adequate B12 absorption.',
      concern: 'A/A — non-secretor (~20% of population). Reduced B12 absorption. Monitor B12 levels, especially on plant-based diets. Also associated with resistance to norovirus.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4588',
    gene: 'GC (VDBP)',
    name: 'Vitamin D Binding Protein',
    category: 'nutrient',
    description: 'GC encodes the Vitamin D binding protein that transports vitamin D in blood. Variants affect circulating 25(OH)D levels and bioavailability. This is one of the strongest genetic determinants of vitamin D status.',
    implications: {
      beneficial: 'C/C — normal VDBP function. Standard vitamin D transport and bioavailability.',
      typical: 'A/C — intermediate effect on vitamin D levels.',
      concern: 'A/A — associated with lower circulating 25(OH)D levels. May need higher supplementation doses to achieve optimal vitamin D status.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === CAFFEINE (additional) ===
  {
    rsid: 'rs762551',
    gene: 'CYP1A2',
    name: 'Caffeine Metabolism Speed',
    category: 'caffeine',
    description: 'CYP1A2 is the primary liver enzyme that metabolizes caffeine. This is the classic "fast vs slow caffeine metabolizer" SNP. Fast metabolizers clear caffeine quickly; slow metabolizers experience prolonged stimulation and higher cardiovascular risk from heavy coffee consumption.',
    implications: {
      beneficial: 'A/A — fast metabolizer. Caffeine is cleared quickly. Moderate coffee consumption may even be cardioprotective.',
      typical: 'A/C — intermediate metabolizer. Moderate caffeine tolerance.',
      concern: 'C/C — slow metabolizer. Caffeine lingers ~4x longer. Associated with increased heart attack risk from heavy coffee consumption (>3 cups/day). Consider limiting intake, especially afternoon and evening.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === DETOXIFICATION (additional) ===
  {
    rsid: 'rs4244285',
    gene: 'CYP2C19',
    name: 'Drug Metabolism / CYP2C19',
    category: 'detox',
    description: 'CYP2C19 metabolizes proton pump inhibitors (omeprazole), antidepressants (citalopram), and antiplatelet drugs (clopidogrel). Poor metabolizers may not activate clopidogrel, risking treatment failure after cardiac stents.',
    implications: {
      beneficial: 'G/G — normal (extensive) metabolizer. Standard drug activation and clearance.',
      typical: 'G/A — intermediate metabolizer. Some drugs may need dose adjustment.',
      concern: 'A/A — poor metabolizer. Clopidogrel may be ineffective. PPIs may accumulate. FDA recommends alternative antiplatelet therapy for CYP2C19 poor metabolizers with cardiac stents.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1800566',
    gene: 'NQO1',
    name: 'Quinone Detoxification (NQO1)',
    category: 'detox',
    description: 'NQO1 detoxifies quinones from diet and environment, preventing oxidative DNA damage. The C609T variant eliminates enzyme activity, reducing protection against benzene toxicity and certain chemotherapy metabolism.',
    implications: {
      beneficial: 'C/C — full NQO1 activity. Normal quinone detoxification and benzene protection.',
      typical: 'C/T — ~50% enzyme activity. Mildly reduced detoxification capacity.',
      concern: 'T/T — no functional NQO1 enzyme. Increased sensitivity to benzene exposure and oxidative stress. Avoid unnecessary chemical exposures.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === COGNITIVE ===
  {
    rsid: 'rs6265',
    gene: 'BDNF',
    name: 'Brain-Derived Neurotrophic Factor (Val66Met)',
    category: 'cognitive',
    description: 'BDNF is critical for neuroplasticity, memory formation, and mood regulation. The Val66Met polymorphism affects activity-dependent BDNF secretion in the brain. Met carriers have reduced hippocampal volume and altered stress response.',
    implications: {
      beneficial: 'G/G (Val/Val) — normal activity-dependent BDNF secretion. Standard neuroplasticity and memory consolidation.',
      typical: 'A/G (Val/Met) — reduced activity-dependent secretion (~25%). May benefit from regular exercise, which strongly upregulates BDNF.',
      concern: 'A/A (Met/Met) — significantly reduced BDNF secretion. Associated with smaller hippocampal volume, altered stress response, and increased depression susceptibility. Exercise is particularly beneficial for this genotype.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === COGNITIVE DECLINE & DEMENTIA RISK ===
  {
    rsid: 'rs429358',
    gene: 'APOE',
    name: 'APOE ε4 Alzheimer\'s Risk (rs429358)',
    category: 'cognitive_decline',
    description: 'APOE ε4 is the strongest common genetic risk factor for late-onset Alzheimer\'s disease. The ε4 allele (T→C at rs429358) impairs amyloid-beta clearance and reduces cerebral glucose metabolism. One copy increases risk ~3x; two copies increase risk ~12x. This SNP combines with rs7412 (ε2) to determine your full APOE haplotype (ε2/ε3/ε4) — see the composite APOE Haplotype marker for combined interpretation.',
    implications: {
      beneficial: 'T/T — no ε4 allele. Lower baseline Alzheimer\'s risk from APOE. Check rs7412 for possible ε2 protective status.',
      concern: 'C/T — one ε4 allele. ~3x increased Alzheimer\'s risk. Prioritize neuroprotective lifestyle: regular cardiovascular exercise, sleep optimization (7-9 hrs), omega-3/DHA (1-2g daily), Mediterranean diet, creatine monohydrate (5g daily for brain energy), and cognitive engagement. Check rs7412 — if also C/T, you may carry the ε2/ε4 combination.',
      major_concern: 'C/C — two ε4 alleles (ε4/ε4). ~12x increased Alzheimer\'s risk. Earliest average onset among APOE genotypes. Aggressive neuroprotective strategy strongly recommended: cardiovascular exercise (150+ min/week), sleep optimization, omega-3/DHA, Mediterranean diet, blood pressure management, metabolic health monitoring, creatine supplementation, and regular cognitive screening starting mid-40s.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'concern' },
      { genotypes: ['C/C'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs7412',
    gene: 'APOE',
    name: 'APOE ε2 Protective Variant (rs7412)',
    category: 'cognitive_decline',
    description: 'APOE ε2 is the protective counterpart to ε4. The ε2 allele (C→T at rs7412) is associated with enhanced amyloid-beta clearance and ~40% reduced Alzheimer\'s risk. This SNP combines with rs429358 (ε4) to determine your full APOE haplotype — see the composite APOE Haplotype marker for combined interpretation.',
    implications: {
      beneficial: 'T/T — ε2/ε2. Strongest APOE-mediated neuroprotection. Significantly reduced Alzheimer\'s risk (~0.6x baseline). Note: rare association with type III hyperlipoproteinemia — monitor lipid panel.',
      typical: 'C/T — one ε2 allele. ~40% reduced Alzheimer\'s risk compared to ε3/ε3. Check rs429358 — if also C/T, you carry ε2/ε4 (mixed risk/protection).',
      concern: 'C/C — no ε2 protective allele. Alzheimer\'s risk determined primarily by rs429358 ε4 status.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3865444',
    gene: 'CD33',
    name: 'CD33 Microglial Clearance',
    category: 'cognitive_decline',
    description: 'CD33 is expressed on microglia and regulates amyloid-beta phagocytosis. The A allele reduces CD33 surface expression, enhancing microglial clearance of amyloid plaques. Replicated across multiple GWAS for Alzheimer\'s risk.',
    implications: {
      beneficial: 'A/A — reduced CD33 expression. Enhanced microglial amyloid clearance. Lower Alzheimer\'s risk.',
      typical: 'A/C — intermediate CD33 levels. Moderate clearance capacity.',
      concern: 'C/C — higher CD33 expression. Reduced amyloid clearance by microglia.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3764650',
    gene: 'ABCA7',
    name: 'ABCA7 Lipid Transport & Amyloid',
    category: 'cognitive_decline',
    description: 'ABCA7 is involved in lipid transport and amyloid precursor protein processing. Loss-of-function variants increase Alzheimer\'s risk ~1.8x, particularly in African-ancestry populations where the effect is stronger.',
    implications: {
      beneficial: 'G/G — normal ABCA7 function. Standard lipid transport and amyloid processing.',
      typical: 'G/T — one risk allele. Mildly elevated Alzheimer\'s risk.',
      concern: 'T/T — reduced ABCA7 function. ~1.8x increased Alzheimer\'s risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs6656401',
    gene: 'CR1',
    name: 'Complement Receptor 1 (Neuroinflammation)',
    category: 'cognitive_decline',
    description: 'CR1 encodes complement receptor 1, part of the innate immune system. The A allele is associated with increased amyloid-beta deposition and neuroinflammation, contributing to Alzheimer\'s risk (~1.2x per allele).',
    implications: {
      beneficial: 'G/G — standard CR1 expression. Normal complement-mediated clearance.',
      typical: 'A/G — one risk allele. Slightly elevated neuroinflammation risk.',
      concern: 'A/A — elevated CR1 risk. Associated with increased amyloid burden and neuroinflammation.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs11136000',
    gene: 'CLU',
    name: 'Clusterin (Apolipoprotein J)',
    category: 'cognitive_decline',
    description: 'CLU (clusterin/apolipoprotein J) is a chaperone protein that binds amyloid-beta and facilitates its clearance across the blood-brain barrier. The T allele is protective, associated with better amyloid clearance.',
    implications: {
      beneficial: 'T/T — protective genotype. Enhanced clusterin-mediated amyloid clearance.',
      typical: 'C/T — intermediate effect. Standard clusterin function.',
      concern: 'C/C — reduced clusterin efficiency. Mildly elevated amyloid accumulation risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs744373',
    gene: 'BIN1',
    name: 'BIN1 Tau & Synaptic Function',
    category: 'cognitive_decline',
    description: 'BIN1 (bridging integrator 1) is the second strongest Alzheimer\'s risk locus after APOE. It\'s involved in tau pathology, synaptic vesicle recycling, and endocytosis. The C allele increases risk ~1.2x per copy.',
    implications: {
      beneficial: 'T/T — lower BIN1-mediated Alzheimer\'s risk. Normal synaptic function.',
      typical: 'C/T — one risk allele. Slightly elevated risk.',
      concern: 'C/C — elevated BIN1 risk. Associated with increased tau pathology and synaptic dysfunction.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs9349407',
    gene: 'PICALM',
    name: 'PICALM Endocytic Clearance',
    category: 'cognitive_decline',
    description: 'PICALM mediates clathrin-mediated endocytosis and amyloid-beta clearance across the blood-brain barrier. Variants affect the efficiency of cellular waste removal in the brain.',
    implications: {
      beneficial: 'C/C — efficient PICALM function. Better endocytic clearance of amyloid.',
      typical: 'C/G — intermediate clearance capacity.',
      concern: 'G/G — reduced PICALM efficiency. Impaired endocytic amyloid clearance.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3851179',
    gene: 'PICALM',
    name: 'PICALM Protective Variant',
    category: 'cognitive_decline',
    description: 'This PICALM variant is independently protective against Alzheimer\'s. The A allele enhances autophagy and tau clearance, reducing accumulation of toxic protein aggregates.',
    implications: {
      beneficial: 'A/A — enhanced autophagy and tau clearance. Protective against Alzheimer\'s.',
      typical: 'A/G — intermediate protective effect.',
      concern: 'G/G — standard PICALM autophagy function. No additional protection.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs10948363',
    gene: 'CD2AP',
    name: 'CD2AP Blood-Brain Barrier Integrity',
    category: 'cognitive_decline',
    description: 'CD2AP maintains blood-brain barrier integrity and supports synaptic function. Variants are associated with Alzheimer\'s risk through impaired BBB function and increased neuroinflammation.',
    implications: {
      beneficial: 'A/A — normal CD2AP function. Intact blood-brain barrier support.',
      typical: 'A/G — intermediate BBB risk.',
      concern: 'G/G — reduced CD2AP function. Associated with BBB dysfunction and elevated Alzheimer\'s risk.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs983392',
    gene: 'MS4A6A',
    name: 'MS4A6A Microglial Activation',
    category: 'cognitive_decline',
    description: 'MS4A6A is part of the membrane-spanning 4A gene cluster expressed in myeloid cells. Variants affect microglial activation patterns and soluble TREM2 levels, both relevant to Alzheimer\'s neuroinflammation.',
    implications: {
      beneficial: 'A/A — protective microglial activation pattern. Higher soluble TREM2.',
      typical: 'A/G — intermediate microglial function.',
      concern: 'G/G — altered microglial activation. Lower soluble TREM2 associated with increased neuroinflammation.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },

  // === SLEEP & CIRCADIAN ===
  {
    rsid: 'rs1801260',
    gene: 'CLOCK',
    name: 'Circadian Clock Gene',
    category: 'sleep',
    description: 'CLOCK is a core circadian rhythm gene. The 3111T>C variant is associated with evening chronotype preference, later sleep onset, shorter sleep duration, and higher resistance to sleep deprivation.',
    implications: {
      beneficial: 'T/T — standard circadian rhythm. Typical sleep-wake preferences.',
      typical: 'T/C — mild evening tendency. Slightly delayed sleep preference.',
      concern: 'C/C — strong evening chronotype. Delayed sleep phase, reduced sleep duration. May struggle with early schedules. Melatonin timing and light exposure management may help.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['T/C', 'C/T'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs57875989',
    gene: 'DEC2/BHLHE41',
    name: 'Short Sleep Gene',
    category: 'sleep',
    description: 'DEC2 (BHLHE41) regulates sleep duration. The rare "short sleeper" mutation allows healthy function on 4-6 hours of sleep without cognitive impairment. Extremely rare (~1% of population).',
    implications: {
      beneficial: 'Carrier of short-sleep variant — may genuinely require less sleep without health consequences.',
      typical: 'No short-sleep variant — standard 7-9 hour sleep requirement for optimal health.'
    },
    rules: [
      { genotypes: ['A/G', 'G/A'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'beneficial' }
    ]
  },
  {
    rsid: 'rs35333999',
    gene: 'PER2',
    name: 'Period Circadian Clock 2',
    category: 'sleep',
    description: 'PER2 is a core circadian clock gene that drives the negative feedback loop controlling ~24-hour rhythms. Variants affect morning/evening preference and sleep timing. PER2 mutations cause Familial Advanced Sleep Phase Syndrome (FASPS) in severe cases.',
    implications: {
      beneficial: 'C/C — standard PER2 function. Normal circadian period length.',
      typical: 'C/T — mildly shifted circadian timing. May trend toward earlier or later sleep phase depending on other clock genes.',
      concern: 'T/T — altered PER2 function. More pronounced chronotype shift. May benefit from timed light exposure and consistent sleep-wake scheduling.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs2287161',
    gene: 'CRY1',
    name: 'Cryptochrome Circadian Clock 1',
    category: 'sleep',
    description: 'CRY1 is a key repressor in the circadian feedback loop. A gain-of-function variant lengthens the circadian period, strongly associated with Delayed Sleep Phase Disorder (DSPD). Carriers naturally drift toward later sleep-wake times.',
    implications: {
      beneficial: 'C/C — standard CRY1 function. Normal circadian period (~24 hours).',
      typical: 'C/G — one variant allele. Mildly extended circadian period. Slight evening tendency.',
      concern: 'G/G — extended circadian period. Strong evening chronotype and delayed sleep onset. Associated with DSPD. Timed morning light exposure and evening light restriction are particularly effective.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },

  // === ATHLETIC PERFORMANCE ===
  {
    rsid: 'rs1815739',
    gene: 'ACTN3',
    name: 'Muscle Fiber Type (Sprint vs Endurance)',
    category: 'athletic',
    description: 'ACTN3 encodes alpha-actinin-3, a protein found exclusively in fast-twitch muscle fibers. The R577X polymorphism determines whether you produce it. ~18% of people worldwide are X/X (no alpha-actinin-3), favoring endurance over sprint/power.',
    implications: {
      beneficial: 'C/C (R/R) — alpha-actinin-3 present. Fast-twitch muscle fibers fully functional. Advantage in sprint, power, and strength activities.',
      typical: 'C/T (R/X) — one functional copy. Mixed fiber profile. Versatile across power and endurance.',
      concern: 'T/T (X/X) — no alpha-actinin-3. Fast-twitch fibers remodeled toward slow-twitch. Natural endurance advantage but reduced peak power output. Not pathological — many elite endurance athletes carry this genotype.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4341',
    gene: 'ACE',
    name: 'ACE Insertion/Deletion (Endurance)',
    category: 'athletic',
    description: 'The ACE I/D polymorphism affects angiotensin-converting enzyme levels. The I allele (lower ACE) is associated with endurance performance and altitude adaptation. The D allele (higher ACE) is associated with power/sprint performance.',
    implications: {
      beneficial: 'G/G — associated with endurance-favorable ACE levels.',
      typical: 'A/G — mixed profile. Balanced endurance and power potential.',
      concern: 'A/A — associated with higher ACE activity. Power-oriented physiology, but also linked to higher blood pressure and cardiovascular strain during prolonged endurance exercise.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === SKIN & UV RESPONSE ===
  {
    rsid: 'rs1805007',
    gene: 'MC1R',
    name: 'Melanin Type / UV Sensitivity',
    category: 'skin',
    description: 'MC1R controls the switch between eumelanin (dark, UV-protective) and pheomelanin (red/yellow, UV-sensitizing). This R151C variant is strongly associated with red hair, fair skin, freckling, and increased melanoma risk.',
    implications: {
      beneficial: 'C/C — normal MC1R function. Standard eumelanin production and UV protection.',
      typical: 'C/T — one variant copy. Mildly increased UV sensitivity and freckling tendency.',
      concern: 'T/T — strongly reduced MC1R function. Fair skin, high UV sensitivity, 2-4x melanoma risk. Rigorous sun protection essential.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === METABOLIC ===
  {
    rsid: 'rs9939609',
    gene: 'FTO',
    name: 'Fat Mass & Obesity Associated Gene',
    category: 'longevity',
    description: 'FTO is the strongest common genetic contributor to obesity risk. The A allele increases appetite, reduces satiety signaling, and is associated with higher BMI. Each A allele adds ~1.5kg average weight. Effect is substantially modifiable by physical activity.',
    implications: {
      beneficial: 'T/T — lower genetic obesity risk. Standard appetite regulation.',
      typical: 'A/T — one risk allele. Modestly increased obesity risk (~1.2x). Regular physical activity largely negates the effect.',
      concern: 'A/A — two risk alleles (~1.7x obesity risk). Reduced satiety signaling. Physically active A/A carriers show almost no excess risk — exercise is the most effective countermeasure for this genotype.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['A/T', 'T/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === BLOOD SUGAR & DIABETES ===
  {
    rsid: 'rs7903146',
    gene: 'TCF7L2',
    name: 'Type 2 Diabetes Risk (TCF7L2)',
    category: 'diabetes',
    description: 'TCF7L2 is the strongest common genetic risk factor for type 2 diabetes, replicated across all ethnicities. The T allele impairs insulin secretion from pancreatic beta cells via altered Wnt signaling. Each T allele increases T2D risk ~1.4x.',
    implications: {
      beneficial: 'C/C — no risk alleles. Standard insulin secretion and beta cell function.',
      typical: 'C/T — one risk allele. ~1.4x increased T2D risk. Maintain healthy weight and monitor fasting glucose.',
      concern: 'T/T — two risk alleles. ~2x increased T2D risk. Impaired insulin secretion. Regular HbA1c monitoring, weight management, and exercise strongly recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs5219',
    gene: 'KCNJ11',
    name: 'Potassium Channel / Insulin Secretion (E23K)',
    category: 'diabetes',
    description: 'KCNJ11 encodes the Kir6.2 subunit of the ATP-sensitive potassium channel in pancreatic beta cells controlling insulin release. The T allele (Lys23) reduces insulin secretion efficiency.',
    implications: {
      beneficial: 'C/C (Glu/Glu) — normal potassium channel function. Standard insulin secretion.',
      typical: 'C/T — heterozygous. Mildly reduced insulin release efficiency.',
      concern: 'T/T (Lys/Lys) — impaired potassium channel regulation. Reduced insulin secretion. ~1.3x T2D risk. Monitor glucose levels.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs13266634',
    gene: 'SLC30A8',
    name: 'Zinc Transporter 8 / Islet Function',
    category: 'diabetes',
    description: 'SLC30A8 encodes a zinc transporter critical for insulin crystallization and storage in pancreatic beta cells. The C allele (Arg325) increases T2D risk ~1.15x per allele. Loss-of-function variants are protective, making this a drug target.',
    implications: {
      beneficial: 'T/T (Trp/Trp) — protective variant. Enhanced beta cell function.',
      typical: 'C/T — one risk allele. Standard islet zinc transport.',
      concern: 'C/C (Arg/Arg) — reduced zinc transport efficiency. Mildly increased T2D risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === GUT HEALTH & DIGESTION ===
  {
    rsid: 'rs4988235',
    gene: 'MCM6 (LCT regulatory)',
    name: 'Lactase Persistence / Lactose Tolerance',
    category: 'gut_health',
    description: 'This regulatory SNP upstream of the LCT gene determines whether lactase production continues into adulthood. The T allele maintains lactase expression. C/C leads to lactase non-persistence (lactose intolerance). One of the strongest signals of recent human natural selection.',
    implications: {
      beneficial: 'T/T — lactase persistent. Full lactose digestion into adulthood.',
      typical: 'C/T — heterozygous. Usually sufficient lactase for moderate dairy consumption.',
      concern: 'C/C — lactase non-persistent. Reduced or absent lactase in adulthood. Likely lactose intolerant. Consider lactase supplements or dairy alternatives.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs2187668',
    gene: 'HLA-DQA1 (DQ2.5)',
    name: 'Celiac Disease Risk (HLA-DQ2.5)',
    category: 'gut_health',
    description: 'HLA-DQ2.5 is carried by ~90% of celiac disease patients. Homozygous carriers have the highest celiac risk (~1 in 10 lifetime). Necessary but not sufficient — ~30% of the general population carries DQ2.5 but only ~3% develop celiac.',
    implications: {
      beneficial: 'T/T — does not carry the DQ2.5 risk haplotype. Lower celiac risk.',
      typical: 'C/T — heterozygous DQ2.5 carrier. Celiac possible but most carriers never develop it. If symptomatic, consider tTG-IgA antibody testing.',
      concern: 'C/C — homozygous DQ2.5 carrier. Highest genetic celiac risk (~5-10% lifetime). Screen with tTG-IgA if GI symptoms, iron deficiency, or family history.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === AUTOIMMUNE RISK ===
  {
    rsid: 'rs2476601',
    gene: 'PTPN22',
    name: 'Autoimmune Susceptibility (R620W)',
    category: 'autoimmune',
    description: 'PTPN22 R620W is one of the strongest non-HLA autoimmune risk variants, replicated across type 1 diabetes, rheumatoid arthritis, lupus, Graves disease, and other autoimmune conditions. The A allele alters T-cell and B-cell receptor signaling thresholds.',
    implications: {
      beneficial: 'G/G — normal PTPN22 function. Standard immune self-tolerance.',
      concern: 'G/A — heterozygous carrier. ~1.5-2x increased risk across multiple autoimmune diseases. Monitor for symptoms.',
      major_concern: 'A/A — homozygous variant. Substantially increased autoimmune risk. Be vigilant for thyroid, joint, or systemic autoimmune symptoms.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'concern' },
      { genotypes: ['A/A'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs3184504',
    gene: 'SH2B3',
    name: 'Immune & Cardiovascular Cross-Risk (SH2B3)',
    category: 'autoimmune',
    description: 'SH2B3 (LNK) regulates signaling in immune and hematopoietic cells. The T allele is associated with increased risk for celiac disease, type 1 diabetes, and cardiovascular disease simultaneously — a cross-domain risk marker. Highly replicated in GWAS.',
    implications: {
      beneficial: 'C/C — normal SH2B3 signaling. Standard immune and cardiovascular risk baseline.',
      typical: 'C/T — one risk allele. Mildly elevated autoimmune and cardiovascular risk.',
      concern: 'T/T — two risk alleles. Elevated risk across celiac, type 1 diabetes, and cardiovascular disease.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === THYROID & HORMONES ===
  {
    rsid: 'rs965513',
    gene: 'FOXE1',
    name: 'Thyroid Disease Susceptibility (FOXE1)',
    category: 'thyroid',
    description: 'FOXE1 (TTF-2) is a thyroid transcription factor essential for thyroid development. This variant is the strongest common genetic risk factor for both hypothyroidism and thyroid cancer. The A allele increases risk ~1.4x per copy.',
    implications: {
      beneficial: 'G/G — lower genetic risk for thyroid disease.',
      typical: 'A/G — one risk allele. Mildly elevated thyroid disease susceptibility.',
      concern: 'A/A — two risk alleles. Elevated risk for hypothyroidism and thyroid cancer. Regular TSH screening recommended.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs225014',
    gene: 'DIO2',
    name: 'Thyroid Hormone Activation (Thr92Ala)',
    category: 'thyroid',
    description: 'DIO2 encodes type 2 deiodinase, converting T4 (inactive) to T3 (active thyroid hormone) in brain and muscle. The Ala92 variant reduces local T3 production. Some patients report persistent hypothyroid symptoms despite normal TSH.',
    implications: {
      beneficial: 'C/C (Thr/Thr) — normal DIO2 activity. Efficient T4-to-T3 conversion.',
      typical: 'C/T — one Ala allele. Mildly reduced tissue T3 levels. Some hypothyroid patients benefit from combination T4+T3 therapy.',
      concern: 'T/T (Ala/Ala) — reduced local T3 production. May experience hypothyroid symptoms despite normal TSH. Discuss T3/T4 ratio with endocrinologist.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === EYE HEALTH ===
  {
    rsid: 'rs1061170',
    gene: 'CFH',
    name: 'Age-Related Macular Degeneration Risk (CFH Y402H)',
    category: 'eye_health',
    description: 'Complement factor H regulates the alternative complement pathway in the retina. Y402H is the strongest genetic risk factor for age-related macular degeneration (AMD), increasing risk ~2.5x per allele. One of the first GWAS successes.',
    implications: {
      beneficial: 'T/T (Tyr/Tyr) — normal complement regulation. Lower AMD risk.',
      concern: 'T/C — one risk allele. ~2.5x increased AMD risk. Regular eye exams after age 50. Consider lutein/zeaxanthin supplementation.',
      major_concern: 'C/C (His/His) — ~6x increased AMD risk. Prioritize retinal screening, AREDS2 formula (lutein/zeaxanthin), smoking cessation, and UV protection.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['T/C', 'C/T'], status: 'concern' },
      { genotypes: ['C/C'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs10490924',
    gene: 'ARMS2/HTRA1',
    name: 'Macular Degeneration Risk (ARMS2)',
    category: 'eye_health',
    description: 'ARMS2/HTRA1 on chromosome 10q26 is the second major AMD locus after CFH. The T allele increases risk ~2.7x per copy. Together with CFH, these two loci explain the majority of genetic AMD risk.',
    implications: {
      beneficial: 'G/G — lower ARMS2-mediated AMD risk.',
      concern: 'G/T — one risk allele. ~2.7x increased AMD risk. Combined with CFH genotype for AMD risk stratification.',
      major_concern: 'T/T — ~7x increased AMD risk from this locus alone. Regular retinal screening strongly recommended. AREDS2 supplementation and UV protection.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'concern' },
      { genotypes: ['T/T'], status: 'major_concern' }
    ]
  },

  // === MENTAL HEALTH ===
  {
    rsid: 'rs6311',
    gene: 'HTR2A',
    name: 'Serotonin Receptor 2A (-1438 A/G)',
    category: 'mental_health',
    description: 'HTR2A encodes the serotonin 2A receptor, a primary target of many antidepressants and antipsychotics. The -1438 A/G promoter variant affects receptor expression levels and antidepressant response.',
    implications: {
      beneficial: 'G/G — standard HTR2A expression. Typical serotonin receptor density.',
      typical: 'A/G — intermediate HTR2A expression. Moderate serotonin receptor variation.',
      concern: 'A/A — increased HTR2A expression. Associated with altered serotonin signaling, increased anxiety sensitivity, and variable SSRI response. May benefit from pharmacogenomic-guided antidepressant selection.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4570625',
    gene: 'TPH2',
    name: 'Tryptophan Hydroxylase 2 / Serotonin Synthesis',
    category: 'mental_health',
    description: 'TPH2 is the rate-limiting enzyme for serotonin synthesis in the brain. The T allele is associated with reduced amygdala regulation, increased anxiety, and susceptibility to depression. Replicated in neuroimaging and psychiatric genetics studies.',
    implications: {
      beneficial: 'G/G — normal TPH2 expression. Standard brain serotonin synthesis.',
      typical: 'G/T — one variant allele. Mildly altered serotonin synthesis. May have increased emotional reactivity.',
      concern: 'T/T — reduced TPH2 expression. Lower brain serotonin synthesis. Increased anxiety and depression susceptibility. Regular exercise and stress management particularly beneficial.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs27072',
    gene: 'SLC6A3 (DAT1)',
    name: 'Dopamine Transporter (DAT1)',
    category: 'mental_health',
    description: 'SLC6A3 encodes the dopamine transporter which clears dopamine from the synapse. The G allele is associated with increased DAT expression (faster dopamine clearance, lower synaptic dopamine), linked to ADHD susceptibility.',
    implications: {
      beneficial: 'C/C — lower DAT expression. Standard synaptic dopamine levels.',
      typical: 'C/G — intermediate DAT expression. Moderate dopamine clearance.',
      concern: 'G/G — higher DAT expression. Faster dopamine clearance. Associated with ADHD traits and stimulant medication response.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },

  // === BONE HEALTH ===
  {
    rsid: 'rs3736228',
    gene: 'LRP5',
    name: 'Bone Mineral Density (LRP5 A1330V)',
    category: 'bone_health',
    description: 'LRP5 is essential for Wnt signaling in osteoblasts and is the strongest single-gene determinant of bone mineral density. The T allele reduces Wnt signaling and is associated with lower BMD and increased fracture risk. Replicated in GEFOS consortium GWAS (>80,000 individuals).',
    implications: {
      beneficial: 'C/C (Ala/Ala) — normal LRP5 Wnt signaling. Standard bone mineral density.',
      typical: 'C/T — one Val allele. Mildly reduced BMD. Ensure adequate calcium, vitamin D, and weight-bearing exercise.',
      concern: 'T/T (Val/Val) — reduced Wnt signaling. Lower bone mineral density and ~1.5x fracture risk. DEXA scan recommended. Prioritize calcium, vitamin D, and resistance training.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1800012',
    gene: 'COL1A1',
    name: 'Collagen Type I Alpha 1 / Osteoporosis',
    category: 'bone_health',
    description: 'COL1A1 encodes the major structural protein in bone. The Sp1 binding site polymorphism alters the collagen alpha1/alpha2 ratio, weakening bone structure. Associated with reduced BMD, vertebral fractures, and osteoporosis.',
    implications: {
      beneficial: 'G/G — normal collagen ratio. Standard bone structural integrity.',
      typical: 'G/T — heterozygous. Mildly altered collagen ratio. Slightly increased fracture risk.',
      concern: 'T/T — significantly altered collagen ratio. Increased osteoporosis and vertebral fracture risk. Bone density screening recommended.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === PHARMACOGENOMICS ===
  {
    rsid: 'rs1065852',
    gene: 'CYP2D6',
    name: 'Drug Metabolism / CYP2D6 (C100T)',
    category: 'pharmacogenomics',
    description: 'CYP2D6 metabolizes ~25% of all prescription drugs including codeine, tamoxifen, antidepressants, beta-blockers, and antipsychotics. Poor metabolizers cannot activate codeine to morphine and may not benefit from tamoxifen.',
    implications: {
      beneficial: 'C/C — normal CYP2D6 activity. Standard drug metabolism for CYP2D6 substrates.',
      typical: 'C/T — intermediate metabolizer. May need dose adjustments for some CYP2D6 substrates.',
      concern: 'T/T — reduced CYP2D6 activity. Codeine may be ineffective. Tamoxifen activation impaired. Pharmacogenomic testing recommended before CYP2D6-dependent drugs.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4148323',
    gene: 'UGT1A1',
    name: 'Bilirubin Conjugation / Gilbert Syndrome (G71R)',
    category: 'pharmacogenomics',
    description: 'UGT1A1 conjugates bilirubin for excretion. The A allele reduces enzyme activity, causing Gilbert syndrome (benign unconjugated hyperbilirubinemia). Also affects metabolism of irinotecan (chemo) and atazanavir (HIV).',
    implications: {
      beneficial: 'G/G — normal UGT1A1 activity. Standard bilirubin conjugation.',
      typical: 'G/A — carrier. Mildly elevated bilirubin. Usually asymptomatic.',
      concern: 'A/A — reduced UGT1A1 activity. Gilbert syndrome likely. Usually benign but critical for irinotecan dosing (severe toxicity risk). Inform oncologist if undergoing chemotherapy.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs9923231',
    gene: 'VKORC1',
    name: 'Warfarin Sensitivity / VKORC1',
    category: 'pharmacogenomics',
    description: 'VKORC1 is the target enzyme of warfarin. This promoter variant is the strongest genetic determinant of warfarin dose, explaining ~25% of dose variability. The T allele reduces VKORC1 expression, requiring lower warfarin doses. FDA-approved pharmacogenomic dosing label.',
    implications: {
      beneficial: 'G/G — normal VKORC1 expression. Standard warfarin dose likely (~5-7 mg/day).',
      typical: 'G/T — intermediate VKORC1 expression. Moderate warfarin sensitivity (~3-5 mg/day typical).',
      concern: 'T/T — low VKORC1 expression. High warfarin sensitivity (~1-3 mg/day). Over-anticoagulation and bleeding risk at standard doses. Pharmacogenomic dosing strongly recommended.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1799853',
    gene: 'CYP2C9',
    name: 'Drug Metabolism / CYP2C9 (*2)',
    category: 'pharmacogenomics',
    description: 'CYP2C9 metabolizes ~15% of prescription drugs including warfarin, phenytoin, NSAIDs, and losartan. The *2 allele reduces enzyme activity ~30%. Combined with VKORC1, explains ~50% of warfarin dose variability. FDA pharmacogenomic dosing label.',
    implications: {
      beneficial: 'C/C — normal CYP2C9 activity (*1/*1). Standard drug metabolism.',
      typical: 'C/T — CYP2C9 *1/*2 intermediate metabolizer. ~30% reduced activity. Consider lower starting doses for warfarin, NSAIDs.',
      concern: 'T/T — CYP2C9 *2/*2 poor metabolizer. ~70% reduced activity. Significantly impaired warfarin, NSAID, and phenytoin metabolism. Pharmacogenomic dosing recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === CANCER PREDISPOSITION ===
  {
    rsid: 'rs61764370',
    gene: 'KRAS (3\'UTR)',
    name: 'KRAS let-7 MicroRNA Binding Variant',
    category: 'tumor_suppression',
    description: 'This variant in the 3\'UTR of KRAS disrupts a let-7 microRNA binding site, increasing KRAS expression. Associated with increased risk for non-small cell lung cancer, ovarian cancer, and triple-negative breast cancer. Particularly relevant for never-smokers with lung cancer.',
    implications: {
      beneficial: 'T/T — normal let-7 regulation of KRAS. Standard cancer risk baseline.',
      concern: 'G/T — one variant allele. Increased KRAS expression. ~1.3x lung and ovarian cancer risk. Follow standard screening guidelines closely.',
      major_concern: 'G/G — significantly increased KRAS expression. Enhanced screening consideration, especially with family history of lung or ovarian cancer.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'concern' },
      { genotypes: ['G/G'], status: 'major_concern' }
    ]
  },

  // === HAIR LOSS ===
  {
    rsid: 'rs2180439',
    gene: '20p11.22',
    name: 'Male Pattern Baldness Risk (20p11)',
    category: 'hair',
    description: 'This locus on chromosome 20p11 is one of the strongest non-X-linked genetic contributors to androgenetic alopecia (male pattern baldness). The C allele increases baldness risk ~1.6x per copy. Unlike X-linked AR gene variants, this is autosomal and inherited from both parents.',
    implications: {
      beneficial: 'T/T — lower genetic risk for androgenetic alopecia from this locus.',
      typical: 'C/T — one risk allele. Moderate genetic predisposition to hair loss.',
      concern: 'C/C — two risk alleles. ~2.5x increased androgenetic alopecia risk. Consider early intervention if hair thinning begins.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === HEARING ===
  {
    rsid: 'rs7598759',
    gene: 'GRM7',
    name: 'Age-Related Hearing Loss (GRM7)',
    category: 'hearing',
    description: 'GRM7 encodes metabotropic glutamate receptor 7, which protects cochlear hair cells from glutamate excitotoxicity. Variants are associated with age-related hearing loss (presbycusis). The risk allele impairs neuroprotective glutamate signaling in the cochlea.',
    implications: {
      beneficial: 'A/A — standard GRM7 function. Normal cochlear neuroprotection.',
      typical: 'A/G — one risk allele. Mildly increased susceptibility to age-related hearing loss.',
      concern: 'G/G — reduced GRM7 neuroprotection. Elevated presbycusis risk. Limit loud noise exposure, use ear protection, and get audiometric screening after age 50.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },

  // === PAIN SENSITIVITY ===
  {
    rsid: 'rs6746030',
    gene: 'SCN9A',
    name: 'Pain Sensitivity (SCN9A)',
    category: 'pain',
    description: 'SCN9A encodes the Nav1.7 sodium channel in pain-sensing neurons. Rare loss-of-function mutations cause complete insensitivity to pain; gain-of-function mutations cause severe pain disorders. The A allele is associated with increased pain sensitivity.',
    implications: {
      beneficial: 'G/G — standard SCN9A function. Typical pain sensitivity.',
      typical: 'A/G — one variant allele. Mildly increased pain perception.',
      concern: 'A/A — increased Nav1.7 channel activity. Heightened pain sensitivity. May require adjusted analgesic approaches.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === ADDITIONS TO EXISTING CATEGORIES ===

  // Cardiovascular: PCSK9
  {
    rsid: 'rs11591147',
    gene: 'PCSK9',
    name: 'PCSK9 Loss-of-Function (R46L)',
    category: 'cardiovascular',
    description: 'PCSK9 degrades LDL receptors, raising LDL cholesterol. The T allele (Leu46) is a loss-of-function variant that lowers lifetime LDL by ~15% and reduces coronary heart disease risk by ~47%. This natural experiment inspired the PCSK9 inhibitor drug class.',
    implications: {
      beneficial: 'Carrier of PCSK9 loss-of-function (G/T or T/T). Lower lifetime LDL cholesterol and significantly reduced coronary heart disease risk (~47%).',
      typical: 'G/G — normal PCSK9 function. Standard LDL receptor turnover and cholesterol levels.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' }
    ]
  },

  // Nutrient: FADS1 omega-3
  {
    rsid: 'rs174547',
    gene: 'FADS1',
    name: 'Omega-3/6 Fatty Acid Desaturase',
    category: 'nutrient',
    description: 'FADS1 encodes delta-5 desaturase, the rate-limiting enzyme for converting plant-based ALA to EPA/DHA omega-3 fatty acids. The C allele has higher activity. The T allele reduces conversion, making dietary preformed EPA/DHA (fish oil) more important.',
    implications: {
      beneficial: 'C/C — higher FADS1 activity. Efficient ALA-to-EPA/DHA conversion. Plant omega-3 sources more effective.',
      typical: 'C/T — intermediate desaturase activity. Moderate omega-3 conversion efficiency.',
      concern: 'T/T — lower FADS1 activity. Poor ALA-to-EPA/DHA conversion. Direct EPA/DHA supplementation (fish oil or algal oil) recommended over plant sources alone.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // Inflammation: CRP
  {
    rsid: 'rs1205',
    gene: 'CRP',
    name: 'C-Reactive Protein Baseline Levels',
    category: 'inflammation',
    description: 'CRP is the most widely used clinical biomarker of systemic inflammation. This variant affects baseline CRP levels independent of inflammation status. Important for interpreting hsCRP blood tests — genetically low CRP may mask inflammation, while genetically high CRP may cause false alarm.',
    implications: {
      beneficial: 'T/T — genetically lower baseline CRP. Favorable inflammatory profile, but hsCRP tests may underestimate true inflammation.',
      typical: 'C/T — intermediate baseline CRP levels.',
      concern: 'C/C — genetically higher baseline CRP. Elevated hsCRP on blood tests may partly reflect genetic tendency rather than active inflammation.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // Longevity: TERC telomere
  {
    rsid: 'rs10936599',
    gene: 'TERC',
    name: 'Telomere Length (TERC)',
    category: 'longevity',
    description: 'TERC encodes the RNA component of telomerase. Shorter telomeres are associated with cellular aging and age-related diseases. The C allele is associated with shorter leukocyte telomere length. Strongly replicated in the largest telomere GWAS meta-analyses.',
    implications: {
      beneficial: 'T/T — associated with longer telomeres. Favorable cellular aging trajectory.',
      typical: 'C/T — intermediate telomere length.',
      concern: 'C/C — associated with shorter telomeres. Accelerated cellular aging. Exercise, stress management, adequate sleep, and Mediterranean diet support telomere maintenance.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // Sleep: MTNR1B melatonin
  {
    rsid: 'rs4753426',
    gene: 'MTNR1B',
    name: 'Melatonin Receptor 1B / Sleep-Glucose Axis',
    category: 'sleep',
    description: 'MTNR1B encodes the melatonin receptor MT2, linking circadian rhythm to insulin secretion. The C allele increases receptor expression, impairing glucose-stimulated insulin release — explaining why late eating disproportionately affects glucose tolerance in carriers.',
    implications: {
      beneficial: 'T/T — normal melatonin receptor expression. Standard circadian insulin coupling.',
      typical: 'C/T — one variant allele. Mildly altered melatonin-insulin coupling. Avoid very late eating.',
      concern: 'C/C — increased MTNR1B expression. Impaired nighttime glucose handling. Higher fasting glucose and T2D risk. Avoid late-night eating and maintain consistent sleep schedule.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // Skin: TYK2 psoriasis
  {
    rsid: 'rs3894194',
    gene: 'TYK2',
    name: 'Psoriasis & Autoimmune Skin Risk (TYK2)',
    category: 'skin',
    description: 'TYK2 encodes tyrosine kinase 2 in the JAK-STAT signaling pathway. Variants affect risk for psoriasis, psoriatic arthritis, and other autoimmune conditions. TYK2 is now a therapeutic target — deucravacitinib selectively inhibits TYK2 for psoriasis treatment.',
    implications: {
      beneficial: 'G/G — lower TYK2-mediated autoimmune skin disease risk.',
      typical: 'G/T — one risk allele. Mildly elevated psoriasis susceptibility.',
      concern: 'T/T — elevated psoriasis and autoimmune skin risk. If symptomatic, TYK2 inhibitors may be particularly effective.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs11209026',
    gene: 'IL23R',
    name: 'IL-23 Receptor / Psoriasis & IBD Protection (R381Q)',
    category: 'skin',
    description: 'IL23R encodes the IL-23 receptor, a key driver of Th17-mediated inflammation in psoriasis, Crohn\'s disease, and ankylosing spondylitis. The rare A allele is strongly protective (~2x reduced risk). IL-23 is the target of multiple biologic drugs.',
    implications: {
      beneficial: 'G/A or A/A — carrier of protective allele. ~2x reduced psoriasis and inflammatory bowel disease risk.',
      typical: 'G/G — no protective variant. Standard baseline risk for Th17-mediated inflammatory conditions.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['G/A', 'A/G'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' }
    ]
  },

  // === BREAST & OVARIAN CANCER ===
  {
    rsid: 'rs2981582',
    gene: 'FGFR2',
    name: 'FGFR2 Breast Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'FGFR2 (Fibroblast Growth Factor Receptor 2) is one of the strongest and most replicated breast cancer GWAS loci. The T allele increases ER-positive breast cancer risk ~1.26x per copy. Stronger association with estrogen receptor-positive disease.',
    implications: {
      beneficial: 'C/C — lower genetic risk for breast cancer at this locus.',
      typical: 'C/T — one risk allele. Mildly elevated breast cancer risk (~1.26x).',
      concern: 'T/T — two risk alleles. ~1.63x increased breast cancer risk, particularly ER-positive subtypes.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3803662',
    gene: 'TOX3',
    name: 'TOX3 Breast Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'TOX3 (TNRC9) at 16q12 is a well-replicated breast cancer susceptibility locus. The T allele correlates with lower TOX3 expression, increasing breast cancer risk ~1.20x per copy. Replicated across multiple populations.',
    implications: {
      beneficial: 'C/C — lower genetic risk at this locus.',
      typical: 'C/T — one risk allele. Modestly increased breast cancer risk (~1.20x).',
      concern: 'T/T — two risk alleles. ~1.40x increased breast cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs889312',
    gene: 'MAP3K1',
    name: 'MAP3K1 Breast Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'MAP3K1 at 5q11 encodes a MAPK kinase involved in cell proliferation signaling. The C allele is associated with modestly increased breast cancer risk (~1.13x per copy).',
    implications: {
      beneficial: 'A/A — lower genetic risk at this locus.',
      typical: 'A/C — one risk allele. Mildly increased breast cancer risk.',
      concern: 'C/C — two risk alleles. ~1.22x increased breast cancer risk.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs13387042',
    gene: '2q35 intergenic',
    name: 'Chromosome 2q35 Breast Cancer Locus',
    category: 'cancer_breast',
    description: 'Intergenic variant at 2q35 with strong replication across European and Hispanic populations. The A allele increases breast cancer risk ~1.15x per copy.',
    implications: {
      beneficial: 'G/G — lower genetic risk at this locus.',
      typical: 'A/G — one risk allele. Mildly increased breast cancer risk.',
      concern: 'A/A — two risk alleles. ~1.40x increased breast cancer risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3817198',
    gene: 'LSP1',
    name: 'LSP1 Breast Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'LSP1 (Lymphocyte-Specific Protein 1) at 11p15. The C allele modestly increases breast cancer risk.',
    implications: {
      beneficial: 'T/T — lower genetic risk at this locus.',
      typical: 'C/T — one risk allele. Small increase in breast cancer risk.',
      concern: 'C/C — two risk alleles. ~1.15x increased breast cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs10941679',
    gene: '5p12/FGF10',
    name: '5p12 ER-Positive Breast Cancer Locus',
    category: 'cancer_breast',
    description: 'Variant near FGF10/MRPS30 at 5p12. The G allele is associated with increased ER-positive breast cancer risk. Stronger effect in estrogen receptor-positive disease.',
    implications: {
      beneficial: 'A/A — lower genetic risk at this locus.',
      typical: 'A/G — one risk allele. Modestly increased ER+ breast cancer risk.',
      concern: 'G/G — two risk alleles. ~1.30x increased ER-positive breast cancer risk.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4973768',
    gene: 'SLC4A7',
    name: 'SLC4A7 Breast Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'SLC4A7 (Solute Carrier Family 4 Member 7) at 3p24. The T allele increases breast cancer risk ~1.11x per copy. Well-replicated in GWAS meta-analyses.',
    implications: {
      beneficial: 'C/C — lower genetic risk at this locus.',
      typical: 'C/T — one risk allele. Small increase in breast cancer risk.',
      concern: 'T/T — two risk alleles. Modestly increased breast cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1045485',
    gene: 'CASP8',
    name: 'CASP8 Breast Cancer Protection (D302H)',
    category: 'cancer_breast',
    description: 'CASP8 (Caspase-8) D302H variant at 2q33. Unusual marker where the minor C allele is protective, reducing breast cancer risk in a dose-dependent manner (OR ~0.89 per C allele).',
    implications: {
      beneficial: 'C/C — protective genotype. Reduced breast cancer risk (~0.74x).',
      typical: 'C/G — one protective allele. Modestly reduced breast cancer risk.',
      concern: 'G/G — common genotype. Standard baseline breast cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/G', 'G/C'], status: 'beneficial' },
      { genotypes: ['G/G'], status: 'typical' }
    ]
  },
  {
    rsid: 'i4000377',
    gene: 'BRCA1',
    name: 'BRCA1 185delAG (Ashkenazi Founder)',
    category: 'cancer_breast',
    description: 'Ashkenazi Jewish founder mutation in BRCA1 (185delAG). FDA-approved 23andMe test. Carriers have ~72% lifetime breast cancer risk and ~44% ovarian cancer risk. High-penetrance pathogenic variant.',
    implications: {
      beneficial: 'I/I — no deletion detected. Standard population-level risk.',
      major_concern: 'D/I — deletion carrier. Very high lifetime risk for breast and ovarian cancer. Genetic counseling strongly recommended.'
    },
    rules: [
      { genotypes: ['I/I'], status: 'beneficial' },
      { genotypes: ['D/I', 'I/D', 'D/D'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'i4000378',
    gene: 'BRCA1',
    name: 'BRCA1 5382insC (Ashkenazi Founder)',
    category: 'cancer_breast',
    description: 'Ashkenazi Jewish founder mutation in BRCA1 (5382insC). FDA-approved 23andMe test. Carriers have substantially elevated lifetime breast and ovarian cancer risk. High-penetrance pathogenic variant.',
    implications: {
      beneficial: 'I/I — no insertion detected. Standard population-level risk.',
      major_concern: 'D/I — insertion carrier. Very high lifetime risk for breast and ovarian cancer. Genetic counseling strongly recommended.'
    },
    rules: [
      { genotypes: ['I/I'], status: 'beneficial' },
      { genotypes: ['D/I', 'I/D', 'D/D'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'i4000379',
    gene: 'BRCA2',
    name: 'BRCA2 6174delT (Ashkenazi Founder)',
    category: 'cancer_breast',
    description: 'Ashkenazi Jewish founder mutation in BRCA2 (6174delT). FDA-approved 23andMe test. Carriers have elevated lifetime risk for breast, ovarian, prostate, and pancreatic cancer. High-penetrance pathogenic variant.',
    implications: {
      beneficial: 'I/I — no deletion detected. Standard population-level risk.',
      major_concern: 'D/I — deletion carrier. Elevated lifetime risk for breast, ovarian, prostate, and pancreatic cancer. Genetic counseling strongly recommended.'
    },
    rules: [
      { genotypes: ['I/I'], status: 'beneficial' },
      { genotypes: ['D/I', 'I/D', 'D/D'], status: 'major_concern' }
    ]
  },
  {
    rsid: 'rs3814113',
    gene: 'BNC2',
    name: 'BNC2 Ovarian Cancer Susceptibility',
    category: 'cancer_breast',
    description: 'BNC2 at 9p22 is the strongest GWAS association for high-grade serous ovarian carcinoma. The C allele is protective, reducing ovarian cancer risk.',
    implications: {
      beneficial: 'C/C — protective genotype. Reduced ovarian cancer risk.',
      typical: 'C/T — one protective allele. Modestly reduced ovarian cancer risk.',
      concern: 'T/T — standard risk genotype for high-grade serous ovarian cancer.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === PROSTATE CANCER ===
  {
    rsid: 'rs6983267',
    gene: '8q24/MYC region',
    name: '8q24 Multi-Cancer Risk Locus',
    category: 'cancer_prostate',
    description: 'One of the most replicated multi-cancer variants at 8q24 near MYC. The G allele affects Wnt/TCF4 signaling and increases prostate cancer risk (~1.26x) and colorectal cancer risk (~1.50x). Population attributable risk ~21%.',
    implications: {
      beneficial: 'T/T — lower genetic risk at this multi-cancer locus.',
      typical: 'G/T — one risk allele. Modestly increased prostate and colorectal cancer risk.',
      concern: 'G/G — two risk alleles. ~1.26x prostate, ~1.50x colorectal cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1447295',
    gene: '8q24 (region 1)',
    name: '8q24 Region 1 Prostate Cancer Locus',
    category: 'cancer_prostate',
    description: 'Independent 8q24 signal for prostate cancer risk. The A allele increases risk ~1.22x per copy. Population attributable risk ~9% for prostate cancer.',
    implications: {
      beneficial: 'C/C — lower genetic risk at this locus.',
      typical: 'A/C — one risk allele. Modestly increased prostate cancer risk.',
      concern: 'A/A — two risk alleles. ~1.44x increased prostate cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs10993994',
    gene: 'MSMB',
    name: 'MSMB Prostate Cancer Susceptibility',
    category: 'cancer_prostate',
    description: 'MSMB (Microseminoprotein-Beta) at 10q11. The T risk allele downregulates MSMB expression by ~70%, increasing prostate cancer risk ~1.24x per copy.',
    implications: {
      beneficial: 'C/C — normal MSMB expression. Lower prostate cancer risk.',
      typical: 'C/T — one risk allele. Reduced MSMB expression, modestly increased prostate cancer risk.',
      concern: 'T/T — significantly reduced MSMB expression (~70% lower). ~1.50x increased prostate cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4430796',
    gene: 'HNF1B',
    name: 'HNF1B Prostate & Endometrial Cancer',
    category: 'cancer_prostate',
    description: 'HNF1B (TCF2) at 17q12 is a pleiotropic locus also associated with type 2 diabetes. The A allele increases prostate cancer risk ~1.25x.',
    implications: {
      beneficial: 'G/G — lower genetic risk at this locus.',
      typical: 'A/G — one risk allele. Modestly increased prostate cancer risk.',
      concern: 'A/A — two risk alleles. ~1.25x increased prostate cancer risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1859962',
    gene: '17q24.3',
    name: 'Chromosome 17q24 Prostate Cancer Locus',
    category: 'cancer_prostate',
    description: 'Variant at 17q24.3 associated with prostate cancer risk. The G allele increases risk ~1.37x for homozygous carriers.',
    implications: {
      beneficial: 'T/T — lower genetic risk at this locus.',
      typical: 'G/T — one risk allele. Modestly increased prostate cancer risk.',
      concern: 'G/G — two risk alleles. ~1.37x increased prostate cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs16901979',
    gene: '8q24 (region 2)',
    name: '8q24 Region 2 Prostate Cancer Locus',
    category: 'cancer_prostate',
    description: 'Independent 8q24 signal from rs6983267 and rs1447295. The A allele increases prostate cancer risk ~1.47x.',
    implications: {
      beneficial: 'C/C — lower genetic risk at this locus.',
      typical: 'A/C — one risk allele. Increased prostate cancer risk.',
      concern: 'A/A — two risk alleles. ~1.47x increased prostate cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === COLORECTAL CANCER ===
  {
    rsid: 'rs4939827',
    gene: 'SMAD7',
    name: 'SMAD7 Colorectal Cancer Protection',
    category: 'cancer_colorectal',
    description: 'SMAD7 at 18q21 modulates TGF-β signaling. The T allele is protective, reducing colorectal cancer risk ~0.77x per copy. Stronger association with rectal than colon cancer.',
    implications: {
      beneficial: 'T/T — protective genotype. Reduced colorectal cancer risk.',
      typical: 'C/T — one protective allele. Modestly reduced colorectal cancer risk.',
      concern: 'C/C — standard risk genotype for colorectal cancer.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs16892766',
    gene: 'EIF3H',
    name: 'EIF3H Colorectal Cancer Susceptibility',
    category: 'cancer_colorectal',
    description: 'EIF3H (Eukaryotic Translation Initiation Factor 3 Subunit H) at 8q23. The C risk allele increases colorectal cancer risk ~1.25x per copy.',
    implications: {
      beneficial: 'A/A — lower genetic risk at this locus.',
      typical: 'A/C — one risk allele. Modestly increased colorectal cancer risk.',
      concern: 'C/C — two risk alleles. ~1.56x increased colorectal cancer risk.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3802842',
    gene: '11q23/LOC120376',
    name: 'Chromosome 11q23 Colorectal Cancer Locus',
    category: 'cancer_colorectal',
    description: 'Variant at 11q23 associated with colorectal cancer. The C allele increases risk, with stronger association for rectal cancer.',
    implications: {
      beneficial: 'A/A — lower genetic risk at this locus.',
      typical: 'A/C — one risk allele. Modestly increased colorectal cancer risk.',
      concern: 'C/C — two risk alleles. ~1.35x increased colorectal cancer risk.'
    },
    rules: [
      { genotypes: ['A/A'], status: 'beneficial' },
      { genotypes: ['A/C', 'C/A'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4779584',
    gene: 'GREM1',
    name: 'GREM1 Colorectal Cancer Susceptibility',
    category: 'cancer_colorectal',
    description: 'GREM1 (Gremlin 1) at 15q13 encodes a BMP antagonist involved in intestinal stem cell regulation. The T allele increases colorectal cancer risk ~1.26x per copy.',
    implications: {
      beneficial: 'C/C — lower genetic risk at this locus.',
      typical: 'C/T — one risk allele. Modestly increased colorectal cancer risk.',
      concern: 'T/T — two risk alleles. Increased colorectal cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === MELANOMA ===
  {
    rsid: 'rs1805008',
    gene: 'MC1R',
    name: 'MC1R R160W Melanoma Risk',
    category: 'cancer_melanoma',
    description: 'MC1R R160W variant affects melanin switching. The T allele is associated with lighter pigmentation and increased melanoma risk (~1.5-2.0x). Weaker effect than MC1R R151C (rs1805007) but contributes to cumulative melanoma risk.',
    implications: {
      beneficial: 'C/C — normal MC1R function at this position. Standard melanoma risk.',
      typical: 'C/T — one variant. Mildly increased UV sensitivity and melanoma risk.',
      concern: 'T/T — reduced MC1R function. Increased melanoma risk. Sun protection recommended.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs1408799',
    gene: 'TYRP1',
    name: 'TYRP1 Melanoma Susceptibility',
    category: 'cancer_melanoma',
    description: 'TYRP1 (Tyrosinase-Related Protein 1) at 9p23 is involved in melanin biosynthesis. The T allele increases melanoma risk ~1.30x.',
    implications: {
      beneficial: 'C/C — lower genetic risk for melanoma at this locus.',
      typical: 'C/T — one risk allele. Modestly increased melanoma risk.',
      concern: 'T/T — two risk alleles. ~1.30x increased melanoma risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },

  // === LUNG CANCER ===
  {
    rsid: 'rs1051730',
    gene: 'CHRNA3',
    name: 'CHRNA3 Lung Cancer & Nicotine Dependence',
    category: 'cancer_lung',
    description: 'CHRNA3 (Cholinergic Receptor Nicotinic Alpha 3) at 15q25. The T allele increases smoking intensity, carcinogen exposure per cigarette, and lung cancer risk ~1.30x per copy. Also associated with COPD.',
    implications: {
      beneficial: 'C/C — lower genetic risk for lung cancer and nicotine dependence at this locus.',
      typical: 'C/T — one risk allele. Increased smoking intensity tendency and lung cancer risk (~1.30x).',
      concern: 'T/T — two risk alleles. ~1.60x lung cancer risk. Higher nicotine dependence. Smoking cessation especially important.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs16969968',
    gene: 'CHRNA5',
    name: 'CHRNA5 Lung Cancer & Nicotine Dependence (D398N)',
    category: 'cancer_lung',
    description: 'CHRNA5 (Cholinergic Receptor Nicotinic Alpha 5) at 15q25. The A allele (D398N) reduces the aversive effects of nicotine, promoting heavier smoking and increasing lung cancer risk. In strong LD with rs1051730. ~28% frequency in Europeans.',
    implications: {
      beneficial: 'G/G — normal nicotinic receptor function. Lower genetic lung cancer risk.',
      typical: 'A/G — one risk allele. Reduced nicotine aversion, modestly increased lung cancer risk (~1.30x).',
      concern: 'A/A — two risk alleles. ~1.60x lung cancer risk. Significantly reduced nicotine aversion.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs8034191',
    gene: 'CHRNA3/5 region',
    name: 'CHRNA3/5 Region Lung Cancer Locus',
    category: 'cancer_lung',
    description: 'Independent signal in the CHRNA3/5 nicotinic receptor gene cluster at 15q25. The C allele increases lung cancer risk ~1.28x per copy.',
    implications: {
      beneficial: 'T/T — lower genetic risk for lung cancer at this locus.',
      typical: 'C/T — one risk allele. Modestly increased lung cancer risk.',
      concern: 'C/C — two risk alleles. ~1.28x increased lung cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === BLADDER CANCER ===
  {
    rsid: 'rs1495741',
    gene: 'NAT2',
    name: 'NAT2 Slow Acetylator (Bladder Cancer)',
    category: 'cancer_bladder',
    description: 'NAT2 at 8p22 determines acetylation status. This tag SNP effectively classifies slow vs rapid acetylators. Slow acetylators (A/A) cannot efficiently detoxify aromatic amines, increasing bladder cancer risk ~1.46x. Especially relevant for smokers and occupational carcinogen exposure.',
    implications: {
      beneficial: 'G/G — rapid acetylator. Efficient aromatic amine detoxification. Lower bladder cancer risk.',
      typical: 'A/G — intermediate acetylator. Moderately efficient detoxification.',
      concern: 'A/A — slow acetylator. Impaired detoxification of aromatic amines. ~1.46x bladder cancer risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs9642880',
    gene: '8q24',
    name: '8q24 Bladder Cancer Locus',
    category: 'cancer_bladder',
    description: 'Variant at the 8q24 multi-cancer risk region specifically associated with bladder cancer. The G allele increases risk ~1.19x per copy.',
    implications: {
      beneficial: 'T/T — lower genetic risk for bladder cancer at this locus.',
      typical: 'G/T — one risk allele. Modestly increased bladder cancer risk.',
      concern: 'G/G — two risk alleles. ~1.40x increased bladder cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['G/T', 'T/G'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs710521',
    gene: 'TP63',
    name: 'TP63 Bladder Cancer Susceptibility',
    category: 'cancer_bladder',
    description: 'TP63 at 3q28 belongs to the p53 gene family and regulates epithelial development. The A allele increases bladder cancer risk ~1.37x for homozygous carriers.',
    implications: {
      beneficial: 'G/G — lower genetic risk at this locus.',
      typical: 'A/G — one risk allele. Modestly increased bladder cancer risk.',
      concern: 'A/A — two risk alleles. ~1.37x increased bladder cancer risk.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === DIGESTIVE CANCER (PANCREATIC & GASTRIC) ===
  {
    rsid: 'rs505922',
    gene: 'ABO',
    name: 'ABO Blood Group Pancreatic Cancer Risk',
    category: 'cancer_digestive',
    description: 'ABO blood group locus at 9q34. The C allele (linked to non-O blood types) increases pancreatic cancer risk ~1.20x per copy. Blood type O is protective. Robustly replicated across diverse populations.',
    implications: {
      beneficial: 'T/T — linked to blood type O. Lower pancreatic cancer risk.',
      typical: 'C/T — intermediate. Modestly increased pancreatic cancer risk.',
      concern: 'C/C — non-O blood type linkage. ~1.20x per allele increased pancreatic cancer risk.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs3790844',
    gene: 'NR5A2',
    name: 'NR5A2 Pancreatic Cancer Protection',
    category: 'cancer_digestive',
    description: 'NR5A2 at 1q32 encodes a nuclear receptor that interacts with β-catenin pathway. The T allele is protective, reducing pancreatic cancer risk ~0.77x per copy.',
    implications: {
      beneficial: 'T/T — protective genotype. Reduced pancreatic cancer risk.',
      typical: 'C/T — one protective allele. Modestly reduced pancreatic cancer risk.',
      concern: 'C/C — standard risk genotype for pancreatic cancer.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs4072037',
    gene: 'MUC1',
    name: 'MUC1 Gastric Cancer Susceptibility',
    category: 'cancer_digestive',
    description: 'MUC1 (Mucin 1) at 1q22 modulates promoter activity and alternative splicing. The G allele is protective against gastric cancer (OR ~0.70). Strongest association in Asian populations, also replicated in European cohorts.',
    implications: {
      beneficial: 'G/G — protective genotype. Reduced gastric cancer risk.',
      typical: 'A/G — one protective allele. Modestly reduced gastric cancer risk.',
      concern: 'A/A — standard/higher risk genotype for gastric cancer.'
    },
    rules: [
      { genotypes: ['G/G'], status: 'beneficial' },
      { genotypes: ['A/G', 'G/A'], status: 'typical' },
      { genotypes: ['A/A'], status: 'concern' }
    ]
  },

  // === MULTI-CANCER TUMOR SUPPRESSORS ===
  {
    rsid: 'rs2736100',
    gene: 'TERT',
    name: 'TERT Telomerase Multi-Cancer Variant',
    category: 'tumor_suppression',
    description: 'TERT (Telomerase Reverse Transcriptase) at 5p15. The C allele increases risk for lung, bladder, thyroid, and glioma (~1.39x), but is inversely associated with breast and colorectal cancer. Direction of effect varies by cancer type. Meta-analysis of 108,248 cases.',
    implications: {
      beneficial: 'T/T — lower risk for lung/bladder/thyroid cancers (but may be slightly higher for breast/colorectal).',
      typical: 'C/T — intermediate. Mixed directional effects depending on cancer type.',
      concern: 'C/C — increased risk for lung, bladder, thyroid cancer, and glioma. Note: may be protective against breast/colorectal cancer.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs2279744',
    gene: 'MDM2',
    name: 'MDM2 SNP309 p53 Pathway Attenuator',
    category: 'tumor_suppression',
    description: 'MDM2 SNP309 at 12q15. The G allele increases MDM2 expression, attenuating the p53 tumor suppressor pathway. Associated with earlier cancer onset (~12 years earlier on average) across multiple cancer types including gastric, liver, colorectal, and gynecological cancers.',
    implications: {
      beneficial: 'T/T — normal MDM2 expression. p53 pathway functions optimally.',
      typical: 'T/G — one risk allele. Moderately increased MDM2 expression. ~1.20x cancer risk.',
      concern: 'G/G — significantly increased MDM2 expression. Attenuated p53 pathway. ~1.54x cancer risk. Earlier age of onset.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['T/G', 'G/T'], status: 'typical' },
      { genotypes: ['G/G'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs17879961',
    gene: 'CHEK2',
    name: 'CHEK2 I157T DNA Damage Response',
    category: 'tumor_suppression',
    description: 'CHEK2 (Checkpoint Kinase 2) I157T at 22q12. This missense variant impairs CHEK2 binding to BRCA1 and p53, compromising DNA damage response. Increases breast cancer risk (~1.5-1.6x) and colorectal cancer risk (~1.6x). Higher penetrance for lobular breast cancer (OR ~4.17).',
    implications: {
      beneficial: 'T/T — normal CHEK2 function. DNA damage checkpoint intact.',
      typical: 'C/T — one variant allele. Partially impaired CHEK2/BRCA1 binding. ~1.5x breast cancer risk.',
      concern: 'C/C — impaired CHEK2 function. Compromised DNA damage response. Enhanced screening recommended.'
    },
    rules: [
      { genotypes: ['T/T'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['C/C'], status: 'concern' }
    ]
  },

  // === THYROID CANCER (additions to existing thyroid category) ===
  {
    rsid: 'rs944289',
    gene: 'NKX2-1/PTCSC3',
    name: 'NKX2-1 Papillary Thyroid Cancer Risk',
    category: 'thyroid',
    description: 'NKX2-1 region at 14q13 regulates PTCSC3 long non-coding RNA tumor suppressor expression. The T allele increases papillary thyroid cancer risk ~1.60x for homozygous carriers.',
    implications: {
      beneficial: 'C/C — lower genetic risk for papillary thyroid cancer.',
      typical: 'C/T — one risk allele. Modestly increased thyroid cancer risk.',
      concern: 'T/T — two risk alleles. ~1.60x increased papillary thyroid cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  },
  {
    rsid: 'rs966423',
    gene: 'DIRC3',
    name: 'DIRC3 Papillary Thyroid Cancer Risk',
    category: 'thyroid',
    description: 'DIRC3 (Disrupted in Renal Carcinoma 3) at 2q35. The T allele is associated with increased papillary thyroid cancer risk.',
    implications: {
      beneficial: 'C/C — lower genetic risk for thyroid cancer at this locus.',
      typical: 'C/T — one risk allele. Modestly increased thyroid cancer risk.',
      concern: 'T/T — two risk alleles. Increased papillary thyroid cancer risk.'
    },
    rules: [
      { genotypes: ['C/C'], status: 'beneficial' },
      { genotypes: ['C/T', 'T/C'], status: 'typical' },
      { genotypes: ['T/T'], status: 'concern' }
    ]
  }
];

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
