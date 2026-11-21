import { lazy, Suspense } from 'react';
import { useParams } from 'react-router';
import { Wand2 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import StoryBuilderIndex, { composeSeedFromIngredients } from '../components/storyBuilder/StoryBuilderIndex';
import { StoryStepRunProvider } from '../components/storyBuilder/useStoryStepRuns.jsx';
import './StoryBuilder.css';

export { composeSeedFromIngredients };

const StoryBuilderDetail = lazy(() => import('../components/storyBuilder/StoryBuilderDetail'));

function DetailFallback() {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        <PageSkeleton label="Loading story session" titleWidthClass="w-64" cards={3} sidebar={false} />
      </div>
    </div>
  );
}

export default function StoryBuilder() {
  const { storyId, step } = useParams();
  if (!storyId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader
          icon={Wand2}
          title="Story Builder"
          subtitle="One guided path from idea to video — start from a seed idea or import a finished work, then review and lock each stage (aesthetic → plot arc → reader map → characters → issues) before moving on."
        />
        <StoryBuilderIndex />
      </div>
    );
  }
  // The provider sits ABOVE the detail view (which itself swaps out for a
  // skeleton on reload and for a "not found" notice on a deleted session), so an
  // in-flight generate/refine survives step navigation AND those swaps (#3905).
  return (
    <StoryStepRunProvider sessionId={storyId}>
      <Suspense fallback={<DetailFallback />}>
        <StoryBuilderDetail key={storyId} storyId={storyId} stepParam={step} />
      </Suspense>
    </StoryStepRunProvider>
  );
}
