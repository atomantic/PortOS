import { Suspense } from 'react';
import { useParams, Navigate } from 'react-router';
import { Cpu } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import Image3dRuntimes from '../components/models/Image3dRuntimes';
import ModelStatusTab from '../components/models/ModelStatusTab';
import CodeReviewersTab from '../components/settings/CodeReviewersTab';
import HarnessesTab from '../components/models/HarnessesTab';
import EmbeddingsTab from '../components/settings/EmbeddingsTab';
import LocalModelAssessments from '../components/settings/LocalModelAssessments.jsx';
import { LocalLlmTab } from '../components/settings/LocalLlmTab';
import { lazyWithReload } from '../utils/lazyWithReload';

// The three panels moved in from the Media Gen tabs were each their own route
// chunk before the move (#4728) — keep them split, or landing on Performance
// downloads the whole LoRA manager and HF-cache browser to render an
// assessments table. The small always-on tabs above stay static.
const Loras = lazyWithReload(() => import('./Loras'));
const LoraTraining = lazyWithReload(() => import('./LoraTraining'));
const LoraDatasetDetail = lazyWithReload(() => import('./LoraDatasetDetail'));
const MediaModels = lazyWithReload(() => import('./MediaModels'));

/**
 * Models — the top-level home for everything about the models this machine runs.
 *
 * The section started as three tabs carved out of `/settings/local-llm`, and now
 * covers every KIND of model an install manages (#4728), not just text:
 *
 *   - **3D** — image-to-3D runtime install/repair (TRELLIS.2, Pixal3D).
 *   - **Code Reviewers** — the review-loop chain and its model/effort pins.
 *   - **Embeddings** — the embedding model backing pgvector search.
 *   - **Harnesses** — the coding-agent CLIs/TUIs, their versions and model lists.
 *   - **LLMs** — focused runtime, model-library, and abuse-guard sub-routes.
 *   - **LoRAs** — installed image/video adapters.
 *   - **Media** — image/video checkpoints and the Hugging Face cache.
 *   - **Performance** — measured assessments and launch-tuning comparison.
 *   - **Status** — residency plus the downloaded-model inventory.
 *   - **Training** — LoRA fine-tuning datasets and runs.
 *
 * What deliberately stayed OUT is output rather than weights: Three.js Models is
 * a gallery of generated meshes, and `/3d` is the render flow that consumes the
 * runtimes listed here. Audio models stayed in the Music studio too — their
 * picker is not separable from the generate form. Design record:
 * `docs/plans/2026-08-21-models-navigation.md`.
 *
 * `?tab` is a route param, not local state, so every one is deep-linkable and
 * reachable from ⌘K and voice (`client/src/AGENTS.md`).
 */
const TAB_CONTENT = {
  '3d': Image3dRuntimes,
  'code-reviewers': CodeReviewersTab,
  embeddings: EmbeddingsTab,
  harnesses: HarnessesTab,
  llms: LocalLlmTab,
  loras: Loras,
  media: MediaModels,
  performance: LocalModelAssessments,
  status: ModelStatusTab,
  training: LoraTraining,
};

/**
 * Drill-downs rendered INSIDE the section shell, keyed by the tab that owns them.
 *
 * A tab's detail view is still that tab — the LoRA dataset workbench is Training
 * with one dataset open — so it keeps the section header and tab bar rather than
 * becoming a bare route that drops both. Under `/media` these pages got that for
 * free, because MediaGen was a layout route; declaring them here gives the same
 * result without every future detail view needing its own special case in
 * App.jsx.
 */
const TAB_DETAIL = {
  training: LoraDatasetDetail,
};

export default function Models() {
  const { tab, recordId } = useParams();
  // An unknown slug lands on LLMs rather than rendering a blank page, matching
  // the section's default destination in App and the primary navigation.
  //
  // OWN-property lookup, not plain indexing: the slug comes straight off the URL,
  // so `/models/constructor` (or `toString`, `__proto__`) would otherwise resolve
  // to an Object.prototype member, read as a valid tab, and get rendered as a
  // component. Same reason `unavailableReasonLabel` guards its map.
  const activeTab = tab && Object.hasOwn(TAB_CONTENT, tab) ? tab : null;
  if (!activeTab) return <Navigate to="/models/llms" replace />;

  // A record id in the URL selects the tab's drill-down, when it has one. Tabs
  // without a detail component receive it as a focused sub-view id (LLMs uses
  // `runtimes`, `library`, and `abuse`); tabs that do not recognize it render their index.
  const DetailContent = recordId && Object.hasOwn(TAB_DETAIL, activeTab) ? TAB_DETAIL[activeTab] : null;
  const TabContent = TAB_CONTENT[activeTab];

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <PageHeader icon={Cpu} title="Models" />

      <ModelsTabsHeader activeTab={activeTab} />

      <div className="flex-1 min-w-0 overflow-auto p-4">
        {/* Local boundary rather than the App-level one: a lazy tab must not blank
            out the section header and tab bar while its chunk loads. */}
        <Suspense fallback={<PageSkeleton header="none" label="Loading models section" cards={3} sidebar={false} />}>
          {DetailContent ? <DetailContent recordId={recordId} /> : <TabContent view={recordId} />}
        </Suspense>
      </div>
    </div>
  );
}
