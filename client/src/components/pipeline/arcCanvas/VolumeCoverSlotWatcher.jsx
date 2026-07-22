import { useEffect } from 'react';
import useMediaJobProgress from '../../../hooks/useMediaJobProgress';

export default function VolumeCoverSlotWatcher({ slot, coverKey, slotKey, onFilename }) {
  const jobId = slot?.filename ? null : slot?.jobId || null;
  const { filename } = useMediaJobProgress(jobId, { kind: 'image' });

  useEffect(() => {
    if (!filename || slot?.filename) return;
    onFilename(coverKey, slotKey, filename);
  }, [coverKey, filename, onFilename, slot?.filename, slotKey]);

  return null;
}
