import AlbumTrackPicker from '../components/music/AlbumTrackPicker';
import PageLayout from '../components/PageLayout';
import { Suspense, useEffect, useState } from 'react';
import { FileCode2, Film, Images } from 'lucide-react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import PageHeader from '../components/PageHeader';
import RouteTabsHeader from '../components/ui/RouteTabsHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import { lazyWithReload } from '../utils/lazyWithReload';
import { useStyleSourceLists } from '../components/media/UniverseMoodBoardPicker';
import { uuidv4 } from '../lib/uuid';
import { safeReadJsonStorage, safeRemoveStorage, safeWriteJsonStorage } from '../lib/safeStorage';
import BriefInputSection from '../components/codeAnimation/BriefInputSection';
import ReferenceAssetsSection from '../components/codeAnimation/ReferenceAssetsSection';
import GenerationOutputSection from '../components/codeAnimation/GenerationOutputSection';
import useCodeAnimationRunner from '../components/codeAnimation/useCodeAnimationRunner';
import { DRAFT_KEY } from '../components/codeAnimation/codeAnimationDraft';

const ProductionProjects = lazyWithReload(() => import('../components/codeAnimation/ProductionProjects'));
const CodeAnimationGallery = lazyWithReload(() => import('../components/codeAnimation/CodeAnimationGallery'));

function FastCodeAnimation() {
  const [searchParams] = useSearchParams();
  const routeParams = useParams();
  const jobId = routeParams.jobId || searchParams.get('job') || '';
  const styleLists = useStyleSourceLists();
  const [trackPickerOpen, setTrackPickerOpen] = useState(false);
  const { draft, update, updateFormat, onStyleGrammarChange, options, limits, assets, writer, output } =
    useCodeAnimationRunner({ jobId, draftId: routeParams.draftId });
  const { playableTracks, handlePickTrack } = assets;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <BriefInputSection
            draft={draft}
            update={update}
            limits={limits}
            options={options}
            updateFormat={updateFormat}
            styleLists={styleLists}
            onStyleGrammarChange={onStyleGrammarChange}
            writer={writer}
          />
          <ReferenceAssetsSection
            draft={draft}
            limits={limits}
            update={update}
            assets={assets}
            onPickTrack={() => setTrackPickerOpen(true)}
          />
        </div>

        <GenerationOutputSection draft={draft} options={options} output={output} boards={styleLists.boards} />
      </div>
      <AlbumTrackPicker
        open={trackPickerOpen}
        tracks={playableTracks}
        onClose={() => setTrackPickerOpen(false)}
        onAdd={([selected]) => {
          if (selected) handlePickTrack(selected);
        }}
        single
        title="Pick soundtrack track"
      />
    </div>
  );
}


// Route-mounted lanes keep inactive galleries and provider calls idle.
function NewCodeAnimation() {
  const [id] = useState(uuidv4);
  useEffect(() => {
    // Carry the pre-UUID draft forward without sharing it with future projects.
    const legacy = safeReadJsonStorage(DRAFT_KEY, null);
    if (legacy) {
      const key = `${DRAFT_KEY}.${id}`;
      safeWriteJsonStorage(key, legacy);
      if (safeReadJsonStorage(key, null)) safeRemoveStorage(DRAFT_KEY);
    }
  }, [id]);
  return <Navigate to={`/code-animation/drafts/${id}`} replace />;
}

export default function CodeAnimation() {
  const { pathname, search } = useLocation();
  const mode = pathname.startsWith('/code-animation/production')
    ? 'production'
    : pathname === '/code-animation/gallery' || pathname.startsWith('/code-animation/gallery/') ? 'gallery' : 'fast';
  return (
    <PageLayout
      header={<PageHeader
        icon={FileCode2}
        title="Code Animation"
        subtitle="Prompt an LLM to code an animated film, with no assets, in a universe's style, then preview it and record it to video."
      />}
      navigation={<RouteTabsHeader
        ariaLabel="Animation mode"
        activeTab={mode}
        tabs={[
          { id: 'fast', label: 'Fast HTML', to: '/code-animation', icon: FileCode2 },
          { id: 'gallery', label: 'Gallery', to: '/code-animation/gallery', icon: Images },
          { id: 'production', label: 'Production', to: '/code-animation/production', icon: Film },
        ]}
      />}
    >
      <div className="mx-auto max-w-7xl">
        <Suspense fallback={<PageSkeleton header="none" label="Loading animation workspace" cards={3} sidebar={false} />}>
          {mode === 'production' ? <ProductionProjects /> : mode === 'gallery' ? <CodeAnimationGallery /> : pathname === '/code-animation' && !new URLSearchParams(search).get('job') ? <NewCodeAnimation /> : <FastCodeAnimation />}
        </Suspense>
      </div>
    </PageLayout>
  );
}
