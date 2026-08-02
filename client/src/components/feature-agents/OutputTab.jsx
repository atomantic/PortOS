import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, RefreshCw } from 'lucide-react';
import * as api from '../../services/api';
import socket from '../../services/socket';

export default function OutputTab({ agent }) {
  const [output, setOutput] = useState('');
  const [agentId, setAgentId] = useState(null);
  const bottomRef = useRef(null);
  // Always holds the currently-selected agent so a response can be matched
  // against it. The refresh button fires outside the fetch effect, so an
  // effect-local `cancelled` flag would not cover it.
  const selectedIdRef = useRef(agent.id);

  const loadOutput = useCallback((id) => {
    api.getFeatureAgentOutput(id).then(data => {
      if (selectedIdRef.current !== id || !data) return;
      setOutput(data.output || '');
      setAgentId(data.agentId);
    }).catch(() => {});
  }, []);

  // Drop the previous agent's output the moment the selection changes —
  // otherwise it lingers until the new fetch lands and reads as though the
  // newly selected agent had already produced it. Keyed on `agent.id` alone so
  // a run starting (`currentAgentId` change) doesn't wipe streamed output.
  useEffect(() => {
    selectedIdRef.current = agent.id;
    setOutput('');
    setAgentId(null);
  }, [agent.id]);

  useEffect(() => {
    loadOutput(agent.id);

    const handler = (data) => {
      if (data.agentId === agent.currentAgentId || data.featureAgentId === agent.id) {
        setOutput(prev => prev + (data.chunk || data.output || ''));
      }
    };
    socket.on('cos:agent:output', handler);
    socket.on('cos:feature-agent:output', handler);

    return () => {
      socket.off('cos:agent:output', handler);
      socket.off('cos:feature-agent:output', handler);
    };
  }, [agent.id, agent.currentAgentId, loadOutput]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  if (!agent.currentAgentId && !output) {
    return (
      <div className="text-center py-16">
        <Terminal size={48} className="mx-auto text-gray-600 mb-4" />
        <h3 className="text-lg font-medium text-gray-400 mb-2">No Active Run</h3>
        <p className="text-sm text-gray-600">Output will appear here when the agent is running.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-500">
          {agent.currentAgentId ? (
            <span className="text-port-success">Running: {agent.currentAgentId}</span>
          ) : (
            <span>Last run output{agentId ? ` (${agentId})` : ''}</span>
          )}
        </div>
        <button
          onClick={() => loadOutput(agent.id)}
          aria-label="Refresh output"
          className="p-1.5 text-gray-400 hover:text-white hover:bg-port-border/50 rounded transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="bg-port-bg border border-port-border rounded-lg p-4 font-mono text-xs text-gray-300 max-h-[600px] overflow-auto whitespace-pre-wrap">
        {output || 'No output yet...'}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
