import { Beer } from 'lucide-react';

export default function AlcoholTab() {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <Beer size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Alcohol Tracking</h3>
      </div>
      <p className="text-gray-500">
        Drink logger with rolling averages, consumption charts, and NIAAA risk thresholds.
      </p>
      <p className="text-sm text-gray-600 mt-2">Coming in Phase 2.</p>
    </div>
  );
}
