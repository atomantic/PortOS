import { ClipboardList } from 'lucide-react';

export default function LifestyleTab() {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <ClipboardList size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Lifestyle Questionnaire</h3>
      </div>
      <p className="text-gray-500">
        Smoking, drinking, exercise, sleep, diet quality, stress level, and BMI inputs.
        Updates feed into death clock calculation.
      </p>
      <p className="text-sm text-gray-600 mt-2">Coming in Phase 4.</p>
    </div>
  );
}
