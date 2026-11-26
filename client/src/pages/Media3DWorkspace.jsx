import { Outlet, useMatch, useNavigate } from 'react-router';
import { Box, Boxes } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';

const TABS = buildPageNavTabs(getPageNavTabs('3d'), {
  meshes: { icon: Boxes },
  threejs: { icon: Box },
}, '3D');

export default function Media3DWorkspace() {
  const navigate = useNavigate();
  const threejs = useMatch('/3d/threejs/*');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={Boxes} title="3D" />
      <TabPills
        tabs={TABS}
        activeTab={threejs ? 'threejs' : 'meshes'}
        onChange={(id) => navigate(TABS.find((tab) => tab.id === id).to)}
        ariaLabel="3D sections"
        mobileCompact
      />
      <div className={`flex-1 min-h-0 ${threejs ? 'overflow-auto p-4' : ''}`}>
        <Outlet />
      </div>
    </div>
  );
}
