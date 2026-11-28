import { Suspense } from 'react';
import { useNavigate } from 'react-router';
import { Brain, Code2 } from 'lucide-react';
import PageSkeleton from '../ui/PageSkeleton';
import TabPills from '../ui/TabPills';
import { lazyWithReload } from '../../utils/lazyWithReload';

const GeneralComparison = lazyWithReload(() => import('./ModelComparison'));
const CodingBenchmarkComparison = lazyWithReload(() => import('./CodingBenchmarkComparison'));
const TABS = [
  { id: 'general', label: 'General intelligence', icon: Brain },
  { id: 'coding', label: 'Coding benchmarks', icon: Code2 },
];
const PATHS = { general: '/models/comparison', coding: '/models/comparison/coding' };

export default function ModelComparisonWorkspace({ view }) {
  const navigate = useNavigate();
  const active = view === 'coding' ? 'coding' : 'general';
  return <div className="min-w-0">
    <TabPills tabs={TABS} activeTab={active} onChange={tab => navigate(PATHS[tab])} mobileCompact ariaLabel="Model comparison view" controlsIdPrefix="comparison-panel" className="mx-3 md:mx-5" />
    <div role="tabpanel" id={`comparison-panel-${active}`} aria-labelledby={`tab-${active}`}>
      <Suspense fallback={<PageSkeleton header="none" label="Loading comparison" sidebar={false} />}>
        {active === 'coding' ? <CodingBenchmarkComparison /> : <GeneralComparison />}
      </Suspense>
    </div>
  </div>;
}
