import { HeartPulse } from 'lucide-react';

export default function BloodTab() {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <HeartPulse size={18} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Blood & Body</h3>
      </div>
      <p className="text-gray-500">
        Blood test panels with reference range highlighting, body composition charts,
        epigenetic age tracking, and eye prescription history.
      </p>
      <p className="text-sm text-gray-600 mt-2">Coming in Phase 3.</p>
    </div>
  );
}
