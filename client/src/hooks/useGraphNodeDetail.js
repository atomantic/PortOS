import { useEffect, useState } from 'react';

/** Load a selected graph record without rendering a previous selection's detail. */
export default function useGraphNodeDetail(selectionKey, loader, recordId) {
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let active = true;
    setDetail(null);
    if (selectionKey != null && loader) {
      Promise.resolve().then(() => loader(recordId)).then(record => {
        if (active) setDetail({ key: selectionKey, record });
      }).catch(() => {
        if (active) setDetail(null);
      });
    }
    return () => { active = false; };
  }, [selectionKey, loader, recordId]);

  return selectionKey != null && loader && detail?.key === selectionKey ? detail.record : null;
}
