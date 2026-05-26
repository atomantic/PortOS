import { Wrench } from 'lucide-react';
import FeatureProviderPicker from '../FeatureProviderPicker';

/**
 * Settings tab for the PortOS Autofixer — picks which configured CLI provider
 * + model runs when a monitored PM2 process crashes. The autofixer reads this
 * (`settings.autofixer`) from the shared data file in its own process.
 */
export function AutofixerTab() {
  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Wrench size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Autofixer AI provider</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          When a monitored process crashes, the Autofixer runs this AI provider to read the logs,
          edit the offending files, and restart the process. Only agentic CLI providers are listed —
          the fixer needs file-edit and shell access, which API chat providers can't do.
        </p>
        <FeatureProviderPicker
          featureKey="autofixer"
          hint="Defaults to Claude Code when unset. Configure providers under AI Providers."
        />
      </div>
    </div>
  );
}
