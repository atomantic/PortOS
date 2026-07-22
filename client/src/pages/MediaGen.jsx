import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { Layers, Image as ImageIcon, Film, History, HardDrive, Scissors, FolderOpen, Sparkles, GraduationCap, Music, PersonStanding } from 'lucide-react';
import TabPills from '../components/ui/TabPills';

const TABS = [
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'timeline', label: 'Timeline', icon: Scissors },
  { id: 'music-video', label: 'Music Video', icon: Music },
  { id: 'sprites', label: 'Sprites', icon: PersonStanding },
  { id: 'history', label: 'History', icon: History },
  { id: 'collections', label: 'Collections', icon: FolderOpen },
  { id: 'loras', label: 'LoRAs', icon: Sparkles },
  { id: 'training', label: 'Training', icon: GraduationCap },
  { id: 'models', label: 'Models', icon: HardDrive }
];

export default function MediaGen() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeTab = pathname.split('/')[2] || 'image';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-port-border">
        <Layers className="w-6 h-6 text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Media Gen</h1>
      </div>

      <TabPills tabs={TABS} activeTab={activeTab} onChange={(id) => navigate(`/media/${id}`)} ariaLabel="Media Gen sections" />

      <div className="flex-1 overflow-auto p-4">
        <Outlet />
      </div>
    </div>
  );
}
