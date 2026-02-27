import { useState, useEffect, useCallback } from 'react';
import { HeartPulse } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import BloodTestCard from '../BloodTestCard';

export default function BloodTab() {
  const [bloodData, setBloodData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const blood = await api.getBloodTests().catch(() => ({ tests: [] }));
    setBloodData(blood);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading blood test data" />
      </div>
    );
  }

  const bloodTests = bloodData?.tests || [];

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <HeartPulse size={18} className="text-red-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Blood Tests ({bloodTests.length})
          </h3>
        </div>
        {bloodTests.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-xl p-6">
            <p className="text-gray-500 text-sm">No blood test data. Import your health spreadsheet or add tests manually.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {[...bloodTests].reverse().map((test, i) => (
              <BloodTestCard key={i} test={test} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
