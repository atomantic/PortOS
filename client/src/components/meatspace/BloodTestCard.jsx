import { REFERENCE_RANGES, getBloodValueStatus, STATUS_COLORS } from './constants';

export default function BloodTestCard({ test }) {
  if (!test) return null;

  const { date, ...values } = test;

  // Group values by category
  const categories = {};
  for (const [key, val] of Object.entries(values)) {
    if (val == null || typeof val !== 'number') continue;
    const range = REFERENCE_RANGES[key];
    const status = getBloodValueStatus(val, range);
    const category = range ? getCategoryForKey(key) : 'Other';
    if (!categories[category]) categories[category] = [];
    categories[category].push({
      key,
      value: val,
      label: range?.label || key,
      unit: range?.unit || '',
      status,
      range
    });
  }

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <h4 className="text-sm font-medium text-gray-300 mb-3">{date}</h4>
      <div className="space-y-3">
        {Object.entries(categories).map(([category, items]) => (
          <div key={category}>
            <h5 className="text-xs font-medium text-gray-500 uppercase mb-1">{category}</h5>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {items.map(item => (
                <div key={item.key} className="flex items-baseline justify-between gap-2 px-2 py-1 rounded bg-port-bg/50">
                  <span className="text-xs text-gray-400 truncate">{item.label}</span>
                  <span className={`text-sm font-mono font-medium ${STATUS_COLORS[item.status]}`}>
                    {item.value}
                    {item.unit && <span className="text-xs text-gray-600 ml-0.5">{item.unit}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function getCategoryForKey(key) {
  const metabolic = [
    'glucose', 'bun', 'creatinine', 'egfr', 'na', 'k', 'ci', 'co2',
    'calcium', 'protein', 'albumin', 'globulin', 'a_g_ratio', 'bilirubin',
    'bili_direct', 'alk_phos', 'sgot_ast', 'alt', 'hba1c', 'anion_gap', 'apoB'
  ];
  const lipids = ['cholesterol', 'hdl', 'ldl', 'triglycerides', 'chol_hdl_ratio', 'non_hdl_col'];
  const cbc = [
    'wbc', 'rbc', 'hemoglobin', 'hematocrit', 'platelets',
    'mcv', 'mch', 'mchc', 'rdw', 'mpv',
    'neutrophils_pct', 'lymphocytes_pct', 'monocytes_pct', 'eosinophils_pct', 'basophils_pct',
    'abs_neutrophils', 'abs_lymphocytes', 'abs_monocytes', 'abs_eosinophils', 'abs_basophils'
  ];
  const thyroid = ['tsh', 'free_t4', 'free_t3'];
  if (metabolic.includes(key)) return 'Metabolic Panel';
  if (lipids.includes(key)) return 'Lipids';
  if (cbc.includes(key)) return 'CBC';
  if (thyroid.includes(key)) return 'Thyroid';
  return 'Other';
}
