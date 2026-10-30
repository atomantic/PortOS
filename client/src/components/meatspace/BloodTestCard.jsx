import { Trash2 } from 'lucide-react';
import { REFERENCE_RANGES, getBloodValueStatus, STATUS_COLORS } from './constants';
import { getCategoryForKey } from '../../lib/clinicianReport';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';

export default function BloodTestCard({ test, confirming = false, onRequestDelete, onConfirmDelete, onCancelDelete }) {
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
      <div className="flex items-center justify-between gap-2 mb-3">
        <h4 className="text-sm font-medium text-gray-300">{date}</h4>
        {test.id && onRequestDelete && (
          confirming ? (
            <ConfirmButtonPair
              prompt="Delete?"
              confirmIcon={Trash2}
              ariaLabel={`Confirm delete blood test ${date}`}
              onConfirm={onConfirmDelete}
              onCancel={onCancelDelete}
            />
          ) : (
            <button
              type="button"
              onClick={onRequestDelete}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-600 hover:text-port-error transition-colors"
              aria-label={`Delete blood test ${date}`}
            >
              <Trash2 size={14} />
            </button>
          )
        )}
      </div>
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
