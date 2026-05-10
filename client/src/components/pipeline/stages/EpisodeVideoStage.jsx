import { Link } from 'react-router-dom';
import { Film, ExternalLink } from 'lucide-react';

/**
 * Episode Video stage — deferred to a follow-up PR. For MVP we expose the
 * placeholder + link to Creative Director, which still has the full
 * scene→render→stitch flow under its own page.
 */
export default function EpisodeVideoStage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Film className="w-5 h-5 text-port-accent" />
        <h2 className="text-lg font-semibold text-white">Episode Video</h2>
      </div>
      <div className="p-4 bg-port-card border border-port-border rounded-lg space-y-3">
        <p className="text-sm text-gray-300">
          Episode-video stitching directly from the storyboards isn't wired through the Pipeline yet. For
          now, drive per-scene video and final stitch from Creative Director, which already has the full
          treatment → scene render → stitch loop.
        </p>
        <p className="text-xs text-gray-500">
          The follow-up here is documented in <code className="text-port-accent">PLAN.md</code> under
          {' '}<em>Pipeline — Deferred</em>.
        </p>
        <Link
          to="/media/creative-director"
          className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline"
        >
          Open Creative Director <ExternalLink size={12} />
        </Link>
      </div>
    </div>
  );
}
