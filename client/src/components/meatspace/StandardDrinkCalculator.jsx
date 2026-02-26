import { useState } from 'react';
import { Calculator } from 'lucide-react';

export default function StandardDrinkCalculator() {
  const [oz, setOz] = useState('');
  const [abv, setAbv] = useState('');

  const pureAlcohol = oz && abv ? (parseFloat(oz) * parseFloat(abv) / 100) : 0;
  const standardDrinks = pureAlcohol > 0 ? Math.round((pureAlcohol / 0.6) * 100) / 100 : 0;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Calculator size={16} className="text-gray-400" />
        <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
          Standard Drink Calculator
        </h4>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="text-xs text-gray-500 block mb-1">Oz</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={oz}
            onChange={e => setOz(e.target.value)}
            placeholder="12"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600"
          />
        </div>
        <span className="text-gray-500 pb-1.5">@</span>
        <div className="flex-1">
          <label className="text-xs text-gray-500 block mb-1">ABV %</label>
          <input
            type="number"
            step="0.1"
            min="0"
            max="100"
            value={abv}
            onChange={e => setAbv(e.target.value)}
            placeholder="5"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white placeholder-gray-600"
          />
        </div>
        <span className="text-gray-500 pb-1.5">=</span>
        <div className="text-center pb-1">
          <span className="text-xs text-gray-500 block">Std drinks</span>
          <span className={`text-lg font-bold ${standardDrinks > 2 ? 'text-port-error' : standardDrinks > 0 ? 'text-port-accent' : 'text-gray-500'}`}>
            {standardDrinks || '—'}
          </span>
        </div>
      </div>
      {pureAlcohol > 0 && (
        <p className="text-xs text-gray-500 mt-2">
          {Math.round(pureAlcohol * 100) / 100} oz pure alcohol ({Math.round(pureAlcohol * 29.5735 * 100) / 100} mL)
        </p>
      )}
    </div>
  );
}
