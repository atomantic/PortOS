import { useNavigate, useLocation, Outlet } from 'react-router';
import { Layers, Image as ImageIcon, Film, History, Scissors, FolderOpen, Pencil, ScanEye } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

// Icon per tab id. The manifest (`tabGroup: 'media'`) owns id/label/order —
// this page owns only how each tab looks.
// LoRAs, Training and Models moved to the Models section (#4728) — they manage
// installed weights, while everything left here generates or browses output.
// Throws at import time on drift.
const TAB_PRESENTATION = {
  image: { icon: ImageIcon },
  video: { icon: Film },
  prompt: { icon: ScanEye },
  annotate: { icon: Pencil },
  timeline: { icon: Scissors },
  history: { icon: History },
  collections: { icon: FolderOpen },
};

export const TABS = buildPageNavTabs(getPageNavTabs('media'), TAB_PRESENTATION, 'Media Gen');

export default function MediaGen() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeTab = pathname.split('/')[2]?.toLowerCase() || 'image';

  return (
    <div className="flex min-w-0 flex-col h-full">
      <PageHeader icon={Layers} title="Media Gen" />

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={(id) => navigate(TABS.find((tab) => tab.id === id).to)}
        ariaLabel="Media Gen sections"
        mobileCompact
        className="w-full min-w-0"
      />

      <div className="min-w-0 flex-1 overflow-auto p-3 sm:p-4">
        <Outlet />
      </div>
    </div>
  );
}
