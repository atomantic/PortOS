import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { Layers, Image as ImageIcon, Film, History, HardDrive, Scissors, FolderOpen, Clapperboard, ListOrdered } from 'lucide-react';

const TABS = [
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'timeline', label: 'Timeline', icon: Scissors },
  { id: 'creative-director', label: 'Creative Director', icon: Clapperboard },
  { id: 'queue', label: 'Render Queue', icon: ListOrdered },
  { id: 'history', label: 'History', icon: History },
  { id: 'collections', label: 'Collections', icon: FolderOpen },
  { id: 'models', label: 'Models', icon: HardDrive }
];

export default function MediaGen() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeTab = pathname.split('/')[2] || 'image';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Layers className="w-6 h-6 text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Media Gen</h1>
      </div>

      <div className="flex border-b border-port-border" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => navigate(`/media/${id}`)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-port-accent border-b-2 border-port-accent bg-port-accent/5'
                  : 'text-gray-400 hover:text-white hover:bg-port-card'
              }`}
              role="tab"
              aria-selected={isActive}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      <Outlet />
    </div>
  );
}
