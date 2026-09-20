import { ScanEye } from 'lucide-react';
import PromptFromMedia from '../components/media/PromptFromMedia';

export default function PromptFromMediaPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <ScanEye className="w-5 h-5 text-port-accent" />
        <div>
          <h2 className="text-lg font-semibold text-white">Prompt from media</h2>
          <p className="text-xs text-gray-400">Analyze an image or video and turn it into an editable generation prompt.</p>
        </div>
      </div>
      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <PromptFromMedia kindDefault="both" alwaysOpen />
      </div>
    </div>
  );
}
