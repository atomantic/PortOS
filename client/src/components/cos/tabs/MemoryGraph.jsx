import { useState, useEffect } from 'react';
import { RefreshCw, Brain } from 'lucide-react';
import * as api from '../../../services/api';

export default function MemoryGraph() {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMemoryGraph().then(setGraphData).catch(() => setGraphData(null)).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="animate-spin text-port-accent" size={24} />
      </div>
    );
  }

  if (!graphData || !graphData.nodes?.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No memory graph data available. Add more memories to see relationships.
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 min-h-[400px]">
      <div className="text-center text-gray-500">
        <Brain size={48} className="mx-auto mb-4 text-port-accent/50" />
        <p>Graph visualization coming soon</p>
        <p className="text-sm mt-2">{graphData.nodes.length} nodes * {graphData.edges.length} connections</p>
      </div>
    </div>
  );
}
