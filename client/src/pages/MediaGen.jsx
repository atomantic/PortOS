import { useNavigate, useLocation, Outlet } from 'react-router';
import { Layers, Image as ImageIcon, Film, History, Scissors, FolderOpen, Box, Pencil } from 'lucide-react';
import TabPills from '../components/ui/TabPills';

// LoRAs, Training and Models moved to the Models section (#4728) — they manage
// installed weights, while everything left here generates or browses output.
export const TABS = [
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'threejs', label: 'Three.js', icon: Box },
  { id: 'annotate', label: 'Annotate', icon: Pencil },
  { id: 'timeline', label: 'Timeline', icon: Scissors },
  { id: 'history', label: 'History', icon: History },
  { id: 'collections', label: 'Collections', icon: FolderOpen }
];

export default function MediaGen() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeTab = pathname.split('/')[2] || 'image';

  return (
    <div className="flex min-w-0 flex-col h-full">
      <div className="flex min-w-0 items-center gap-3 p-3 sm:p-4 border-b border-port-border">
        <Layers className="w-6 h-6 text-port-accent" />
        <h1 className="min-w-0 truncate text-2xl font-bold text-white">Media Gen</h1>
      </div>

      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={(id) => navigate(`/media/${id}`)}
        ariaLabel="Media Gen sections"
        mobileDropdown
        mobileSelectId="media-gen-section-select"
        className="w-full min-w-0"
      />

      <div className="min-w-0 flex-1 overflow-auto p-3 sm:p-4">
        <Outlet />
      </div>
    </div>
  );
}
