import { Scale } from 'lucide-react';
import BodyCompChart from '../BodyCompChart';

export default function BodyTab() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Scale size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Body Composition</h3>
        </div>
        <BodyCompChart />
      </div>
    </div>
  );
}
