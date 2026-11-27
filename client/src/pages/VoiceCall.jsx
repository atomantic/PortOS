import { useState } from 'react';
import { AudioLines, Settings2 } from 'lucide-react';
import Drawer from '../components/Drawer';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import AvatarRuntimeSettings from '../components/voice/AvatarRuntimeSettings';
import { VoiceTab } from '../components/settings/VoiceTab';
import { useVoiceConsole, useVoiceEnabled } from '../components/voice/VoiceWidgetGate';

export default function VoiceCall() {
  const enabled = useVoiceEnabled();
  const setConsoleHost = useVoiceConsole();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <PageLayout header={<PageHeader title="Voice Call" icon={AudioLines} />}>
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">Use your PortOS voice agent from this browser.</p>
          <button type="button" onClick={() => setShowSettings(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-port-border bg-port-card px-3 text-sm hover:border-port-accent">
            <Settings2 size={16} aria-hidden="true" /> Model &amp; voice settings
          </button>
        </div>
        {enabled ? <div ref={setConsoleHost} /> : (
          <div className="rounded-xl border border-port-border bg-port-card p-5 text-sm">
            Enable Voice in <strong>Model &amp; voice settings</strong> to start a call.
          </div>
        )}
      </div>
      <Drawer open={showSettings} onClose={() => setShowSettings(false)} title="Model & voice settings"
        subtitle="Changes apply to PortOS Voice on this instance, not just this call." size="xl">
        {showSettings && <div className="space-y-4"><AvatarRuntimeSettings /><VoiceTab showCallLink={false} /></div>}
      </Drawer>
    </PageLayout>
  );
}
