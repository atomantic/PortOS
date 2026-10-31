import { useState, useEffect, useCallback } from 'react';
import { HeartPulse } from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import BloodTestCard from '../BloodTestCard';
import LoadFailureNotice from '../LoadFailureNotice';
import CollapsibleListItem from '../../ui/CollapsibleListItem';
import useConfirmDelete from '../../../hooks/useConfirmDelete';

export default function BloodTab() {
  const [bloodData, setBloodData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const fetchData = useCallback(async () => {
    const blood = await api.getBloodTests({ silent: true }).catch(() => null);
    setFailed(blood === null);
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
            Blood Tests ({failed ? '...' : bloodTests.length})
          </h3>
        </div>
        {failed ? (
          <LoadFailureNotice message="Could not load blood tests. Retry." onRetry={fetchData} />
        ) : bloodTests.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-xl p-6">
            <p className="text-gray-500 text-sm">No blood test data. Import your health spreadsheet or add tests manually.</p>
          </div>
        ) : (
          <div>
            {[...bloodTests].reverse().map((test) => (
              <CollapsibleListItem
                key={test.id || test.date}
                spacing="1rem"
                removing={removingId === test.id}
                onExited={() => {
                  setBloodData(prev => ({ ...prev, tests: (prev?.tests || []).filter(row => row.id !== test.id) }));
                  setRemovingId(null);
                }}
              >
                <BloodTestCard
                  test={test}
                  confirming={isConfirming(test.id)}
                  onRequestDelete={() => requestDelete(test.id)}
                  onConfirmDelete={() => confirmDelete(async () => {
                    const removed = await api.removeBloodTest(test.id).catch(() => null);
                    if (removed) setRemovingId(test.id);
                  })}
                  onCancelDelete={cancelDelete}
                />
              </CollapsibleListItem>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
