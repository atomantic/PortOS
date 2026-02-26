import { Apple } from 'lucide-react';

export default function NutritionTab() {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Apple size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Nutrition</h3>
      </div>
      <p className="text-gray-500">
        Macro tracking, mercury exposure from seafood, daily limits vs actuals.
      </p>
      <p className="text-sm text-gray-600 mt-2">Coming in Phase 4.</p>
    </div>
  );
}
