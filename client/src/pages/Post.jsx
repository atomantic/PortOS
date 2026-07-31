import { Zap } from 'lucide-react';
import { useParams } from 'react-router-dom';
import PostTab from '../components/meatspace/tabs/PostTab';

export default function Post() {
  const { tab, subtab, mode } = useParams();

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <Zap size={24} className="text-port-warning" />
          <h1 className="text-2xl font-bold text-white">POST</h1>
          <span className="text-sm text-gray-500">Physical Observation &amp; Screening Tests</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <PostTab tab={tab} subtab={subtab} mode={mode} />
      </div>
    </div>
  );
}
