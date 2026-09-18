import { useEffect, useState } from 'react';
import ModelsPanel from './ModelsPanel.jsx';
import { getTrackedModelInventory } from '../../services/api';
import { useSystemResourceReport } from '../../hooks/useSystemResourceReport.js';

/**
 * Models → Status: what is resident right now, plus what is on disk.
 *
 * Residency (`MemoryManagement`) and the downloaded-model inventory used to be
 * two pages in two sections — `/models/status` and Dev Tools'
 * `/system-resources/models` — answering the same question ("what models does
 * this machine have, and what is loaded?") in different places. `ModelsPanel`
 * already rendered residency above the inventory, so folding them is a matter of
 * hosting that panel here and feeding it the shared scan (#4728).
 *
 * The scan is still deliberately NOT run on mount: it walks the Hugging Face
 * cache, `data/loras/`, Ollama and LM Studio, which is slow and pointless for a
 * user who came here to unload a model. What arrives instead is the MANIFEST —
 * the record the server keeps as models are installed and deleted — so the
 * inventory is on screen immediately and the scan becomes the explicit "Refresh"
 * that reconciles it with the disk.
 *
 * The manifest only fills an EMPTY slot (`previous ?? tracked`). Today the panel
 * cannot start a scan before the record lands — the Refresh button is behind
 * `initializing` — but the rule is what makes this safe if that ever changes: a
 * scan read the disk itself, and must never be replaced by the cheaper record.
 */
export default function ModelStatusTab() {
  const { report, setReport, loading, runReport, cleanup } = useSystemResourceReport();
  const [trackedLoaded, setTrackedLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    getTrackedModelInventory({ silent: true }).catch(() => null).then((tracked) => {
      if (!active) return;
      setTrackedLoaded(true);
      // `reconciledAt: null` means no scan has ever verified this install, so an
      // empty list is "we have not looked" rather than "nothing installed" —
      // leave the panel on its run-the-inventory prompt.
      if (tracked?.reconciledAt || tracked?.models?.downloaded?.length) {
        setReport((previous) => previous ?? tracked);
      }
    });
    return () => { active = false; };
  }, [setReport]);

  return (
    <ModelsPanel
      report={report}
      loading={loading}
      initializing={!trackedLoaded}
      onRunReport={runReport}
      cleanup={cleanup}
    />
  );
}
