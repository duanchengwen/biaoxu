import { lazy, Suspense } from 'react';
import type { SectionId } from '../shared/types/navigation';
import type { SettingsPageRequest } from '../features/settings/types';
import { getAppMenuItemById } from './menuConfig';
import DeveloperDemoPage, { isDeveloperDemoSection } from '../features/developer/pages/DeveloperDemoPage';
import ProjectHomePage from '../features/technical-plan/pages/ProjectHomePage';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';

const TechnicalPlanHome = lazy(() => import('../features/technical-plan/pages/TechnicalPlanHome'));
const FeasibilityReportHome = lazy(() => import('../features/feasibility-report/pages/FeasibilityReportHome'));
const KnowledgeBasePage = lazy(() => import('../features/knowledge-base/pages/KnowledgeBasePage'));
const CredentialLibraryPage = lazy(() => import('../features/credential-library/pages/CredentialLibraryPage'));
const ResourcesPage = lazy(() => import('../features/resources/pages/ResourcesPage'));
const PluginsPage = lazy(() => import('../features/plugins/pages/PluginsPage'));
const DuplicateCheckPage = lazy(() => import('../features/duplicate-check/pages/DuplicateCheckPage'));
const RejectionCheckPage = lazy(() => import('../features/rejection-check/pages/RejectionCheckPage'));
const BlindCheckPage = lazy(() => import('../features/blind-check/pages/BlindCheckPage'));
const MyTemplatesPage = lazy(() => import('../features/export-format/pages/MyTemplatesPage'));
const SettingsPage = lazy(() => import('../features/settings/pages/SettingsPage'));
const DeveloperTestPage = lazy(() => import('../features/developer/pages/DeveloperTestPage'));
const DeveloperMultimodalTestPage = lazy(() => import('../features/developer/pages/DeveloperMultimodalTestPage'));
const ContentExpansionReplaceTestPage = lazy(() => import('../features/developer/pages/ContentExpansionReplaceTestPage'));
const ContentLayoutBudgetTestPage = lazy(() => import('../features/developer/pages/ContentLayoutBudgetTestPage'));
const AgentTestPage = lazy(() => import('../features/developer/pages/AgentTestPage'));

interface AppRouterProps {
  activeSection: SectionId;
  developerMode: boolean;
  onDeveloperModeChange: (developerMode: boolean) => void;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  settingsRequest?: SettingsPageRequest | null;
  onSettingsRequestHandled?: () => void;
}

function WorkspaceRouteFallback() {
  return (
    <div className="page-stack" role="status" aria-live="polite">
      <div className="project-home-loading">正在打开工作区…</div>
    </div>
  );
}

function AppRouter({ activeSection, developerMode, onDeveloperModeChange, onSectionChange, registerLeaveGuard, settingsRequest, onSettingsRequestHandled }: AppRouterProps) {
  const activeMenuItem = getAppMenuItemById(activeSection, developerMode);

  if (activeSection === 'bid-generation') {
    return <ProjectHomePage onNavigate={onSectionChange} />;
  }

  if (activeMenuItem?.children?.length) {
    return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
  }

  if (isDeveloperDemoSection(activeSection)) {
    return <DeveloperDemoPage sectionId={activeSection} />;
  }

  let route = null;

  switch (activeSection) {
    case 'technical-plan':
      route = <TechnicalPlanHome registerLeaveGuard={registerLeaveGuard} onNavigate={onSectionChange} />;
      break;
    case 'feasibility-report':
      route = <FeasibilityReportHome registerLeaveGuard={registerLeaveGuard} />;
      break;
    case 'document-knowledge-base':
      route = <KnowledgeBasePage />;
      break;
    case 'credential-library':
      route = <CredentialLibraryPage developerMode={developerMode} />;
      break;
    case 'resources':
      route = <ResourcesPage />;
      break;
    case 'plugin-manager':
      route = <PluginsPage />;
      break;
    case 'duplicate-check':
      route = <DuplicateCheckPage />;
      break;
    case 'rejection-check':
      route = <RejectionCheckPage />;
      break;
    case 'blind-check':
      route = <BlindCheckPage />;
      break;
    case 'template-settings':
      route = <MyTemplatesPage />;
      break;
    case 'developer-test':
      return null;
    case 'developer-json-test':
      route = <DeveloperTestPage />;
      break;
    case 'developer-multimodal-test':
      route = <DeveloperMultimodalTestPage />;
      break;
    case 'developer-expansion-replace-test':
      route = <ContentExpansionReplaceTestPage />;
      break;
    case 'developer-layout-budget-test':
      route = <ContentLayoutBudgetTestPage />;
      break;
    case 'developer-agent-test':
      route = <AgentTestPage />;
      break;
    case 'settings':
      route = <SettingsPage onDeveloperModeChange={onDeveloperModeChange} request={settingsRequest} onRequestHandled={onSettingsRequestHandled} registerLeaveGuard={registerLeaveGuard} />;
      break;
    default:
      return null;
  }

  return <Suspense fallback={<WorkspaceRouteFallback />}>{route}</Suspense>;
}

export default AppRouter;
