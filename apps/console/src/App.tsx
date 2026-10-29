import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { SETTINGS_REDIRECTS } from '@/shell/nav';
import { useUser } from '@/store/session';
import { AppShell, PageFallback } from '@/shell/AppShell';
import { ErrorBoundary } from '@/features/system/ErrorBoundary';
import { SystemWatch } from '@/features/system/SystemWatch';
import { RequirePerm } from '@/features/system/RequirePerm';
import { endSessionIfBrowserClosed } from '@/features/auth/keepSignedIn';

// 'Keep me signed in' was off and the browser has been closed since: the stored session ends here
endSessionIfBrowserClosed();

const p = <T extends Record<string, unknown>>(f: () => Promise<T>, name = 'default') => lazy(async () => ({ default: (await f())[name] as React.ComponentType }));

// auth and onboarding
const LoginPage = p(() => import('@/features/auth/LoginPage'));
const SignupPage = p(() => import('@/features/auth/SignupPage'));
const ForgotPage = p(() => import('@/features/auth/ForgotPage'));
const ResetPage = p(() => import('@/features/auth/ResetPage'));
const InvitePage = p(() => import('@/features/auth/InvitePage'));
const OnboardingPage = p(() => import('@/features/onboarding/OnboardingPage'));
// public
const VerifyPage = p(() => import('@/features/verify/VerifyPage'));
const DevelopersPage = p(() => import('@/features/developers/DevelopersPage'));
const ApproveByLinkPage = p(() => import('@/features/approvals/ApproveByLinkPage'));
// console
const TodayPage = p(() => import('@/features/today/TodayPage'));
const ApprovalsPage = p(() => import('@/features/approvals/ApprovalsPage'));
const ApprovalSettingsPage = p(() => import('@/features/approvals/ApprovalSettingsPage'));
const ActivityPage = p(() => import('@/features/activity/ActivityPage'));
const ReceiptPage = p(() => import('@/features/activity/ReceiptPage'));
const ChainPage = p(() => import('@/features/activity/ChainPage'));
const AgentsPage = p(() => import('@/features/agents/AgentsPage'));
const AgentNewPage = p(() => import('@/features/agents/AgentNewPage'));
const AgentDetailPage = p(() => import('@/features/agents/AgentDetailPage'));
const AgentMapPage = p(() => import('@/features/agents/AgentMapPage'));
const RulebooksPage = p(() => import('@/features/rulebooks/RulebooksPage'));
const RulebookPage = p(() => import('@/features/rulebooks/RulebookPage'));
const SuggestionsPage = p(() => import('@/features/rulebooks/SuggestionsPage'));
const ConnectorsPage = p(() => import('@/features/connectors/ConnectorsPage'));
const ConnectorPage = p(() => import('@/features/connectors/ConnectorPage'));
const EvidencePage = p(() => import('@/features/evidence/EvidencePage'));
const AuditorPage = p(() => import('@/features/auditor/AuditorPage'));
const InventoryPage = p(() => import('@/features/inventory/InventoryPage'));
const AiSystemPage = p(() => import('@/features/inventory/AiSystemPage'));
const AssessmentsPage = p(() => import('@/features/assessments/AssessmentsPage'));
const AssessmentPage = p(() => import('@/features/assessments/AssessmentPage'));
const CompliancePage = p(() => import('@/features/compliance/CompliancePage'));
const FrameworkPage = p(() => import('@/features/compliance/FrameworkPage'));
const AlertsPage = p(() => import('@/features/alerts/AlertsPage'));
const AlertPage = p(() => import('@/features/alerts/AlertPage'));
const IncidentsPage = p(() => import('@/features/incidents/IncidentsPage'));
const IncidentPage = p(() => import('@/features/incidents/IncidentPage'));
const BillingPage = p(() => import('@/features/billing/BillingPage'));
const AssurancePage = p(() => import('@/features/assurance/AssurancePage'));
// the four doors — new screens
const NotDonePage = p(() => import('@/features/work/NotDonePage'));
const ChannelsPage = p(() => import('@/features/work/ChannelsPage'));
const RecordsPage = p(() => import('@/features/records/RecordsPage'));
const RecordPage = p(() => import('@/features/records/RecordPage'));
const AutonomyPage = p(() => import('@/features/agentsdoor/AutonomyPage'));
const KeysPage = p(() => import('@/features/agentsdoor/KeysPage'));
const PeoplePage = p(() => import('@/features/agentsdoor/PeoplePage'));
const OrganisationPage = p(() => import('@/features/agentsdoor/OrganisationPage'));
const AssuranceHomePage = p(() => import('@/features/assurancedoor/AssuranceHomePage'));
const RefusalsPage = p(() => import('@/features/assurancedoor/RefusalsPage'));
const ExportsPage = p(() => import('@/features/assurancedoor/ExportsPage'));
const YouPage = p(() => import('@/features/you/YouPage'));
// assurance levels L2 / L3 / Sovereign and the rest of the platform (placeholders until each screen is built)
const ReviewsPage = p(() => import('@/features/work/ReviewsPage'));
const ApproversPage = p(() => import('@/features/work/ApproversPage'));
const PacksPage = p(() => import('@/features/packs/PacksPage'));
const PackPage = p(() => import('@/features/packs/PackPage'));
const PortfolioPage = p(() => import('@/features/packs/PortfolioPage'));
const ErasurePage = p(() => import('@/features/erasure/ErasurePage'));
const ConsentPage = p(() => import('@/features/records/ConsentPage'));
const DeclarationsPage = p(() => import('@/features/records/DeclarationsPage'));
const DeploymentPage = p(() => import('@/features/deployment/DeploymentPage'));
const ProductionPathPage = p(() => import('@/features/developers/console/ProductionPage'));
const UpgradePage = p(() => import('@/features/assurance/UpgradePage'));
const CloseoutPage = p(() => import('@/features/assurance/CloseoutPage'));
const AnchorsPage = p(() => import('@/features/anchors/AnchorsPage'));
const ProfilesPage = p(() => import('@/features/profiles/ProfilesPage'));
const CounterpartiesPage = p(() => import('@/features/counterparties/CounterpartiesPage'));
const DisclosurePage = p(() => import('@/features/disclosure/DisclosurePage'));
const CounterpartyPortalPage = p(() => import('@/features/portal/CounterpartyPortalPage'));
const StatusPage = p(() => import('@/features/status/StatusPage'));
const NoticesPage = p(() => import('@/features/status/NoticesPage'));
const LegalPage = p(() => import('@/features/legal/LegalPage'));
const FingerprintPrintPage = p(() => import('@/features/keys/FingerprintPrintPage'));
const EvidenceRequestsPage = p(() => import('@/features/auditor/EvidenceRequests'));
// system
const NotFoundPage = p(() => import('@/features/system/NotFoundPage'));
const PublicNotFoundPage = p(() => import('@/features/system/NotFoundPage'), 'PublicNotFoundPage');
const ForbiddenPage = p(() => import('@/features/system/ForbiddenPage'));
const MaintenancePage = p(() => import('@/features/system/MaintenancePage'));
const OfflinePage = p(() => import('@/features/system/OfflinePage'));

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useUser();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return <>{children}</>;
}

/**
 * An address no route knows. Signed in: the 404 inside the console shell. Signed out: a public 404 with the ways
 * in (sign in, /verify, /developers) — not a trip to sign-in for a page that does not exist. Real console routes
 * keep their own RequireAuth, so a signed-out visitor to one still goes to /login?next=.
 */
function UnknownAddress() {
  const user = useUser();
  if (!user) return <S><PublicNotFoundPage /></S>;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function SettingsRedirect() {
  const { section = '' } = useParams();
  return <Navigate to={SETTINGS_REDIRECTS[section] ?? '/agents/organisation'} replace />;
}

const S = ({ children }: { children: ReactNode }) => <Suspense fallback={<PageFallback />}>{children}</Suspense>;

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ErrorBoundary>
        <SystemWatch />
        <Routes>
          <Route path="/login" element={<S><LoginPage /></S>} />
          <Route path="/signup" element={<S><SignupPage /></S>} />
          <Route path="/forgot" element={<S><ForgotPage /></S>} />
          <Route path="/reset/:token" element={<S><ResetPage /></S>} />
          <Route path="/invite/:token" element={<S><InvitePage /></S>} />
          <Route path="/onboarding" element={<RequireAuth><S><OnboardingPage /></S></RequireAuth>} />
          <Route path="/verify" element={<S><VerifyPage /></S>} />
          <Route path="/developers/*" element={<S><DevelopersPage /></S>} />
          <Route path="/approve/:token" element={<S><ApproveByLinkPage /></S>} />
          <Route path="/counterparty/:token" element={<S><CounterpartyPortalPage /></S>} />
          <Route path="/status" element={<S><StatusPage /></S>} />
          <Route path="/legal" element={<Navigate to="/legal/privacy" replace />} />
          <Route path="/legal/:doc" element={<S><LegalPage /></S>} />
          <Route path="/fingerprint/:org" element={<S><FingerprintPrintPage /></S>} />
          <Route path="/maintenance" element={<S><MaintenancePage /></S>} />
          <Route path="/offline" element={<S><OfflinePage /></S>} />

          <Route element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route index element={<TodayPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="approvals/settings" element={<ApprovalSettingsPage />} />
            <Route path="approvals/:id" element={<ApprovalsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="activity/chain" element={<ChainPage />} />
            <Route path="activity/:seq" element={<ReceiptPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/new" element={<RequirePerm perm="agents.manage" what="Adding an agent"><AgentNewPage /></RequirePerm>} />
            <Route path="agents/map" element={<AgentMapPage />} />
            <Route path="agents/:slug" element={<AgentDetailPage />} />
            <Route path="rulebooks" element={<RulebooksPage />} />
            <Route path="rulebooks/suggestions" element={<SuggestionsPage />} />
            <Route path="rulebooks/:slug" element={<RulebookPage />} />
            <Route path="connectors" element={<ConnectorsPage />} />
            <Route path="connectors/:id" element={<ConnectorPage />} />
            <Route path="evidence" element={<EvidencePage />} />
            <Route path="auditor" element={<AuditorPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="inventory/:id" element={<AiSystemPage />} />
            <Route path="assessments" element={<AssessmentsPage />} />
            <Route path="assessments/:id" element={<AssessmentPage />} />
            <Route path="compliance" element={<CompliancePage />} />
            <Route path="compliance/:framework" element={<FrameworkPage />} />
            <Route path="alerts" element={<AlertsPage />} />
            <Route path="alerts/:id" element={<AlertPage />} />
            <Route path="incidents" element={<IncidentsPage />} />
            <Route path="incidents/:id" element={<IncidentPage />} />
            <Route path="billing" element={<RequirePerm roles={['owner', 'admin']} what="The meter and invoices"><BillingPage /></RequirePerm>} />
            {/* 01 Work */}
            <Route path="work" element={<Navigate to="/" replace />} />
            <Route path="work/not-done" element={<NotDonePage />} />
            <Route path="work/reviews" element={<ReviewsPage />} />
            <Route path="work/approvers" element={<RequirePerm roles={['owner', 'admin']} what="Approver telemetry and sampling"><ApproversPage /></RequirePerm>} />
            <Route path="work/channels" element={<ChannelsPage />} />
            {/* 02 Records */}
            <Route path="records" element={<RecordsPage />} />
            <Route path="records/packs" element={<PacksPage />} />
            <Route path="records/packs/portfolio" element={<PortfolioPage />} />
            <Route path="records/packs/:id" element={<PackPage />} />
            <Route path="records/erasure" element={<ErasurePage />} />
            <Route path="records/consent" element={<ConsentPage />} />
            <Route path="records/declarations" element={<DeclarationsPage />} />
            <Route path="records/:key" element={<RecordPage />} />
            {/* 03 Agents */}
            <Route path="agents/autonomy" element={<AutonomyPage />} />
            <Route path="agents/keys" element={<KeysPage />} />
            <Route path="agents/people" element={<PeoplePage />} />
            <Route path="agents/organisation" element={<OrganisationPage />} />
            <Route path="agents/deployment" element={<DeploymentPage />} />
            <Route path="agents/production" element={<ProductionPathPage />} />
            <Route path="agents/notices" element={<NoticesPage />} />
            {/* 04 Assurance */}
            <Route path="assurance" element={<AssuranceHomePage />} />
            <Route path="assurance/anchors" element={<AnchorsPage />} />
            <Route path="assurance/refusals" element={<RefusalsPage />} />
            <Route path="assurance/profiles" element={<ProfilesPage />} />
            <Route path="assurance/counterparties" element={<CounterpartiesPage />} />
            <Route path="assurance/disclosure" element={<DisclosurePage />} />
            <Route path="assurance/exports" element={<ExportsPage />} />
            <Route path="assurance/evidence-requests" element={<EvidenceRequestsPage />} />
            <Route path="assurance/levels" element={<AssurancePage />} />
            <Route path="assurance/upgrade" element={<UpgradePage />} />
            <Route path="assurance/upgrade/closeout" element={<CloseoutPage />} />
            {/* personal — account menu, not a door */}
            <Route path="you" element={<YouPage />} />
            {/* there is no fifth door: old Settings links land in the door that now holds them */}
            <Route path="settings" element={<SettingsRedirect />} />
            <Route path="settings/:section" element={<SettingsRedirect />} />
            <Route path="403" element={<ForbiddenPage />} />
          </Route>
          {/* outside the sign-in guard: signed-out visitors to an unknown address get the public 404 */}
          <Route path="*" element={<UnknownAddress />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
