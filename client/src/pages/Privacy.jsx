import { useNavigate } from 'react-router-dom';
import { Shield, LayoutDashboard, KeyRound, Building2, Repeat, ShieldOff } from 'lucide-react';
import { useValidTab } from '../hooks/useValidTab';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import PrivacyOverviewTab from '../components/privacy/PrivacyOverviewTab';
import PrivacyVaultTab from '../components/privacy/PrivacyVaultTab';
import PrivacyOrgsTab from '../components/privacy/PrivacyOrgsTab';
import PrivacyChangesTab from '../components/privacy/PrivacyChangesTab';
import PrivacyBrokersTab from '../components/privacy/PrivacyBrokersTab';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
// Each id maps to `/privacy/<id>` and needs a NAV_COMMANDS entry.
export const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'vault', label: 'Vault', icon: KeyRound },
  { id: 'organizations', label: 'Organizations', icon: Building2 },
  { id: 'changes', label: 'Changes', icon: Repeat },
  { id: 'brokers', label: 'Brokers', icon: ShieldOff },
];

export default function Privacy() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'overview');

  const renderTab = () => {
    switch (activeTab) {
      case 'vault': return <PrivacyVaultTab />;
      case 'organizations': return <PrivacyOrgsTab />;
      case 'changes': return <PrivacyChangesTab />;
      case 'brokers': return <PrivacyBrokersTab />;
      case 'overview':
      default: return <PrivacyOverviewTab />;
    }
  };

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={Shield}
        title="Privacy Center"
        subtitle="Your PII vault and who holds it"
      />
      <TabPills
        tabs={TABS}
        activeTab={activeTab}
        onChange={(id) => navigate(`/privacy/${id}`)}
        mobileDropdown
        mobileSelectId="privacy-tab-select"
        ariaLabel="Privacy Center sections"
      />
      <div className="pt-4">
        {renderTab()}
      </div>
    </div>
  );
}
