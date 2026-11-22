import { useNavigate, useLocation, Outlet } from 'react-router';
import { Layers, Image as ImageIcon, Film, History, Scissors, FolderOpen, Box, Pencil, ScanEye } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

// Icon per tab id. The manifest (`tabGroup: 'media'`) owns id/label/order —
// this page owns only how each tab looks; the page-local "History"/"Three.js"
// labels (vs the manifest's "Media History"/"Three.js Models", which need the
// qualifier to be unambiguous in ⌘K) come from the manifest's `tabLabel`.
// LoRAs, Training and Models moved to the Models section (#4728) — they manage
// installed weights, while everything left here generates or browses output.
// Throws at import time on drift.
const TAB_PRESENTATION = {
  image: { icon: ImageIcon },
  video: { icon: Film },
  prompt: { icon: ScanEye },
  threejs: { icon: Box },
  annotate: { icon: Pencil },
  timeline: { icon: Scissors },
  history: { icon: History },
  collections: { icon: FolderOpen },
};

export const TABS = buildPageNavTabs(getPageNavTabs('media'), TAB_PRESENTATION, 'Media Gen');

export default function MediaGen() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Generate Video lives at `/video/generate` (sibling of the Video workspace),
  // not `/media/video`. The tab id is still `video`.
  const activeTab = pathname.startsWith('/video/generate') ? 'video' : (pathname.split('/')[2] || 'image');

  return (
    <div className="flex min-w-0 flex-col h-full">
      <PageHeader icon={Layers} title="Media Gen" />

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={(id) => navigate(id === 'video' ? '/video/generate' : `/media/${id}`)}
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
