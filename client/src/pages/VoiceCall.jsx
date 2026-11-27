import { useState } from 'react';
import { Radio, Settings2 } from 'lucide-react';
import Drawer from '../components/Drawer';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { VoiceTab } from '../components/settings/VoiceTab';
import { useVoiceConsole, useVoiceEnabled } from '../components/voice/VoiceWidgetGate';

export default function VoiceCall() {
  const enabled = useVoiceEnabled();
  const setConsoleHost = useVoiceConsole();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <PageLayout
      header={
        <PageHeader
          title="Voice Call"
          subtitle="Video-enabled satellite transceiver & local AvatarForcing station."
          icon={Radio}
          actions={
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="satphone-key inline-flex min-h-11 items-center gap-2 rounded-lg border px-3.5 font-mono text-xs font-semibold uppercase tracking-wider"
            >
              <Settings2 size={15} aria-hidden="true" />
              Model &amp; voice settings
            </button>
          }
        />
      }
    >
      <div className="mx-auto max-w-6xl space-y-4">
        {enabled ? (
          <div ref={setConsoleHost} />
        ) : (
          <div className="satphone-chassis mx-auto max-w-xl rounded-2xl border p-6 text-port-text">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-port-border bg-port-bg text-port-accent">
                <Radio size={24} aria-hidden="true" />
              </div>
              <div className="min-w-0 space-y-2">
                <h2 className="font-mono text-sm font-bold uppercase tracking-wider">Transceiver standby</h2>
                <p className="text-sm text-port-text-muted">
                  Enable Voice in <strong>Model &amp; voice settings</strong> to start a call.
                </p>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="satphone-key inline-flex min-h-11 items-center gap-2 rounded-lg border px-3.5 font-mono text-xs font-semibold uppercase tracking-wider text-port-accent-text"
                  >
                    <Settings2 size={15} aria-hidden="true" />
                    Configure voice
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <Drawer
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="Model & voice settings"
        subtitle="Changes apply to PortOS Voice on this instance, not just this call."
        size="xl"
      >
        {showSettings && <VoiceTab showCallLink={false} />}
      </Drawer>
    </PageLayout>
  );
}
