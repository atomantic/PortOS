import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Shield, LayoutDashboard, KeyRound, Building2, Repeat, ShieldOff } from 'lucide-react';
import { useValidTab } from '../hooks/useValidTab';
import useUrlParams from '../hooks/useUrlParams';
import { getPrivacySubjects } from '../services/api';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import PrivacyOverviewTab from '../components/privacy/PrivacyOverviewTab';
import PrivacyVaultTab from '../components/privacy/PrivacyVaultTab';
import PrivacyOrgsTab from '../components/privacy/PrivacyOrgsTab';
import PrivacyChangesTab from '../components/privacy/PrivacyChangesTab';
import PrivacyBrokersTab from '../components/privacy/PrivacyBrokersTab';
import SubjectSwitcher from '../components/privacy/SubjectSwitcher';
import SubjectsDrawer from '../components/privacy/SubjectsDrawer';
import { SELF_SUBJECT_ID, privacyTabPath } from '../components/privacy/constants';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

// Icon per tab id. The manifest (`tabGroup: 'privacy'`) owns id/label/order —
// this page owns only how each tab looks; the page-local "Overview" label
// (vs. the manifest's "Privacy") comes from the manifest's `tabLabel`. Throws
// at import time on drift.
const TAB_PRESENTATION = {
  overview: { icon: LayoutDashboard },
  vault: { icon: KeyRound },
  organizations: { icon: Building2 },
  changes: { icon: Repeat },
  brokers: { icon: ShieldOff },
};

export const TABS = buildPageNavTabs(getPageNavTabs('privacy'), TAB_PRESENTATION, 'Privacy');

export default function Privacy() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'overview');
  const [searchParams, updateParams] = useUrlParams();
  const [subjects, setSubjects] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Which household subject is in scope lives in the URL (#3658), so a view of
  // a specific person's records is shareable and reload-safe — same rule as any
  // other selection. An absent param means `self`, matching the server default.
  const subjectId = searchParams.get('subject') || SELF_SUBJECT_ID;

  useEffect(() => {
    getPrivacySubjects({ silent: true })
      .then((rows) => setSubjects(rows || []))
      .catch(() => setSubjects([]));
  }, []);

  // `self` is the default scope, so it stays out of the URL entirely — a null
  // patch value is `useUrlParams`'s delete signal.
  const selectSubject = useCallback((id) => {
    updateParams({ subject: id === SELF_SUBJECT_ID ? null : id }, { replace: true });
  }, [updateParams]);

  const handleCreated = (subject) => {
    setSubjects((prev) => [...prev, { ...subject, consentCount: 1, recordCount: 0 }]);
    selectSubject(subject.id);
  };

  const handleDeleted = (deletedId) => {
    setSubjects((prev) => prev.filter((s) => s.id !== deletedId));
    // Never strand the view on a subject that no longer exists.
    if (deletedId === subjectId) selectSubject(SELF_SUBJECT_ID);
  };

  // Carry the subject across tabs, but drop tab-local params (e.g. the brokers
  // tab's `?case=`) so switching tabs can't reopen a stale drawer.
  const goToTab = (id) => navigate(privacyTabPath(id, subjectId));

  const renderTab = () => {
    switch (activeTab) {
      case 'vault': return <PrivacyVaultTab subjectId={subjectId} />;
      case 'organizations': return <PrivacyOrgsTab subjectId={subjectId} />;
      case 'changes': return <PrivacyChangesTab subjectId={subjectId} />;
      case 'brokers': return <PrivacyBrokersTab subjectId={subjectId} />;
      case 'overview':
      default: return <PrivacyOverviewTab subjectId={subjectId} />;
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
        onChange={goToTab}
        mobileDropdown
        mobileSelectId="privacy-tab-select"
        ariaLabel="Privacy Center sections"
      />
      <div className="pt-4">
        <SubjectSwitcher
          subjects={subjects}
          subjectId={subjectId}
          onChange={selectSubject}
          onManage={() => setDrawerOpen(true)}
        />
      </div>
      {/* Keying on the subject remounts the tab when the scope changes, so ALL
          of its local state resets at once — revealed plaintext, open drawers,
          expanded rows, filters. Clearing those by hand inside each tab's
          `load()` both missed some and fired on ordinary post-mutation
          refetches, collapsing rows the user had just opened. */}
      <div className="pt-4" key={subjectId}>
        {renderTab()}
      </div>

      <SubjectsDrawer
        open={drawerOpen}
        subjects={subjects}
        onClose={() => setDrawerOpen(false)}
        onCreated={handleCreated}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
