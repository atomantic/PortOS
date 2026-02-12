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
  sleep: { label: 'Sleep & Circadian', icon: 'Moon', color: 'violet' },
  athletic: { label: 'Athletic Performance', icon: 'Dumbbell', color: 'sky' },
  skin: { label: 'Skin & UV Response', icon: 'Sun', color: 'yellow' }
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
