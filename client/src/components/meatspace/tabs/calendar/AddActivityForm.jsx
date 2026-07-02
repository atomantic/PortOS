import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ICON_MAP, IconForName } from './icons';
import { FormField } from '../../../ui/FormField';

export default function AddActivityForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('day');
  const [frequency, setFrequency] = useState('1');
  const [icon, setIcon] = useState('circle');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ name: name.trim(), cadence, frequency: parseFloat(frequency) || 1, icon });
    setName('');
    setFrequency('1');
    setIcon('circle');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white border border-dashed border-port-border rounded hover:border-port-accent/50 transition-colors"
      >
        <Plus size={14} />
        Add
      </button>
    );
  }

  const iconOptions = Object.keys(ICON_MAP);

  return (
    <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Name" labelClassName="text-xs text-gray-400 mb-1 block">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Coffees"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
            autoFocus
          />
        </FormField>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Icon</label>
          <div className="flex gap-1 flex-wrap">
            {iconOptions.map(ic => (
              <button
                key={ic}
                type="button"
                onClick={() => setIcon(ic)}
                className={`p-1.5 rounded ${icon === ic ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'}`}
              >
                <IconForName name={ic} size={14} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Frequency" labelClassName="text-xs text-gray-400 mb-1 block">
          <input
            type="number"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            min="0.01"
            step="0.5"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
          />
        </FormField>
        <FormField label="Cadence" labelClassName="text-xs text-gray-400 mb-1 block">
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
          >
            <option value="day">Per Day</option>
            <option value="week">Per Week</option>
            <option value="month">Per Month</option>
            <option value="year">Per Year</option>
          </select>
        </FormField>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 bg-port-accent text-white text-sm rounded hover:bg-port-accent/80 transition-colors">
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-gray-400 text-sm hover:text-white transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}
