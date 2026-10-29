import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, Navigate, useParams } from 'react-router-dom';
import { LEGAL_ENTITY } from '@/lib/company';
import { cn } from '@/lib/cn';
import { Badge, LegalDraft } from '@/components/ui';
import { PublicChrome } from '@/features/verify/PublicChrome';

/**
 * Public legal pages: the privacy notice, the cookie policy and the sub-processor list, beside the terms and the
 * DPA in the developer portal. Linked from sign-up and from every public footer. Drafts until legal review.
 */
type DocId = 'privacy' | 'cookies' | 'sub-processors';
const DOCS: { id: DocId; title: string; lead: string }[] = [
  { id: 'privacy', title: 'Privacy notice', lead: `How ${LEGAL_ENTITY} handles personal data about the people who use Elan1 Govern and this website, and what your rights are.` },
  { id: 'cookies', title: 'Cookie policy', lead: 'What Elan1 Govern keeps in your browser, why, and for how long. There are no advertising or analytics cookies.' },
  { id: 'sub-processors', title: 'Sub-processors', lead: `The companies ${LEGAL_ENTITY} uses to run hosted Elan1 Govern, what each one receives and where. Sovereign deployments use none.` },
];
export const LEGAL_UPDATED = '28 October 2026';

export default function LegalPage() {
  const { doc } = useParams();
  const current = DOCS.find((d) => d.id === doc);
  useEffect(() => { document.title = `${current?.title ?? 'Legal'} · Elan1 Govern`; window.scrollTo(0, 0); }, [current]);
  if (!current) return <Navigate to="/legal/privacy" replace />;
  return (
    <PublicChrome>
      <div className="mx-auto max-w-[1080px] px-4 py-8 lg:px-8 lg:py-12 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Legal" className="lg:sticky lg:top-20 self-start">
          <p className="label mb-2">Legal</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 lg:block lg:space-y-1 text-sm">
            {DOCS.map((d) => (
              <li key={d.id}><NavLink to={`/legal/${d.id}`} className={({ isActive }) => cn('inline-block py-1 lg:border-l-2 lg:pl-3', isActive ? 'font-semibold text-fg lg:border-fg' : 'text-muted hover:text-fg lg:border-transparent')}>{d.title}</NavLink></li>
            ))}
            <li><Link to="/developers/legal#terms" className="inline-block py-1 lg:border-l-2 lg:border-transparent lg:pl-3 text-muted hover:text-fg">Terms of service</Link></li>
            <li><Link to="/developers/legal#dpa" className="inline-block py-1 lg:border-l-2 lg:border-transparent lg:pl-3 text-muted hover:text-fg">Data processing agreement</Link></li>
          </ul>
        </nav>
        <article className="min-w-0 max-w-[76ch]">
          <p className="label text-accent-fg">Legal</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tighter2 leading-[1.05]">{current.title}</h1>
          <p className="mt-3 text-md text-muted leading-relaxed">{current.lead}</p>
          <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted"><Badge>Last updated {LEGAL_UPDATED}</Badge><span>{LEGAL_ENTITY}</span></p>
          <LegalDraft className="mt-5" />
          <div className="mt-6">{current.id === 'privacy' ? <Privacy /> : current.id === 'cookies' ? <Cookies /> : <SubProcessors />}</div>
          <p className="mt-10 border-t border-line pt-5 text-sm text-muted">Questions about this page: <a className="link" href="mailto:privacy@elan1.ai">privacy@elan1.ai</a>. Contracts and the DPA: <a className="link" href="mailto:legal@elan1.ai">legal@elan1.ai</a>.</p>
        </article>
      </div>
    </PublicChrome>
  );
}

const H2 = ({ id, children }: { id?: string; children: ReactNode }) => <h2 id={id} className="mt-9 scroll-mt-20 text-xl font-semibold border-b border-line pb-2">{children}</h2>;
const P = ({ children }: { children: ReactNode }) => <p className="mt-3 text-[15px] leading-relaxed text-fg/90">{children}</p>;
const UL = ({ children }: { children: ReactNode }) => <ul className="mt-3 list-[square] pl-5 space-y-1.5 text-[15px] leading-relaxed text-fg/90">{children}</ul>;

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-4 overflow-x-auto border border-line">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken/80"><tr className="border-b border-line">{head.map((h) => <th key={h} scope="col" className="h-10 px-3 text-left label font-semibold align-bottom">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-line last:border-b-0 align-top">{r.map((c, j) => j === 0 ? <th key={j} scope="row" className="px-3 py-2.5 text-left font-medium">{c}</th> : <td key={j} className="px-3 py-2.5 text-fg/85">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/* ── Privacy notice ─────────────────────────────────────────────────────── */

function Privacy() {
  return (
    <>
      <H2 id="who">Who we are and when this notice applies</H2>
      <P>{LEGAL_ENTITY} (“Elan1”, “we”) makes Elan1 Govern. This notice covers the personal data of people who sign up, sign in, approve, review or audit in the console, people who use the developer portal, the public verifier and the status page, and people who write to us.</P>
      <P>It does not cover the records your organisation keeps in Elan1 Govern about its own customers or staff. For those your organisation is the data fiduciary and Elan1 is its data processor under the <Link to="/developers/legal#dpa" className="link">data processing agreement</Link>; ask your organisation about them.</P>

      <H2 id="what">What we collect and why</H2>
      <Table caption="Personal data we process" head={['What', 'Why', 'Legal basis', 'Kept for']} rows={[
        ['Name, work email, job title, role, organisation', 'To create your account, sign you in and show who did what', 'Performance of the contract with your organisation; legitimate use (DPDP Act section 7)', 'While the account is active, then 1 year'],
        ['Password (stored only as a salted hash), authenticator secret, session records', 'To keep your account secure; to sign out other sessions when you change your password', 'As above', 'Sessions 30 days; the rest while the account is active'],
        ['Your decisions as an approver, reviewer or owner (who, when, which channel)', 'They are part of the receipt your organisation relies on as evidence', 'Your organisation’s instructions under the DPA', 'With your organisation’s receipts: at least 8 years where the law requires it'],
        ['WhatsApp number (if you verify one)', 'To send you approval messages with a link to the call; and, on rules your organisation marks approvable in chat, to let you approve or reject with the buttons on that message. A decision made that way is recorded with it: the receipt names you and WhatsApp as the channel, and the number is the one bound to you when you verified it', 'Your consent, which you can withdraw in You › Approve in chat', 'Until you remove it; receipts carry only a keyed hash of it'],
        ['Security logs: IP address, browser, sign-in attempts', 'To detect and investigate misuse; CERT-In directions', 'Legal obligation', '1 year (at least 180 days in India)'],
        ['Support emails', 'To answer you', 'Legitimate use', '2 years after the conversation ends'],
      ]} />
      <P>We do not use your data for advertising, we do not sell it, and we do not build profiles of you. Elan1 Govern never stores your agents’ model prompts or message bodies.</P>

      <H2 id="where">Where it is kept</H2>
      <P>Hosted Elan1 Govern stores your records in India: AWS ap-south-1 (Mumbai), with encrypted backups in ap-south-2 (Hyderabad). The few companies that help us run it are on the <Link to="/legal/sub-processors" className="link">sub-processor list</Link>, with where each one is. Three can be outside India: DigiCert, which receives only a hash of each batch and no personal data, and Slack and WhatsApp, only if your organisation switches them on. A Sovereign deployment runs on your organisation’s own infrastructure; nothing about you reaches Elan1 from it.</P>

      <H2 id="rights">Your rights</H2>
      <UL>
        <li><strong>Access and correction.</strong> Most of your details are under You in the console. Ask us for anything else.</li>
        <li><strong>Erasure.</strong> We delete account data you ask us to, unless the law makes us keep it. Your decisions inside your organisation’s receipts are its evidence; for those, ask your organisation, which can erase personal fields by salt destruction while the chain keeps verifying.</li>
        <li><strong>Withdraw consent</strong> where we rely on it, at any time, as easily as you gave it.</li>
        <li><strong>Nominate</strong> someone to exercise your rights if you die or cannot act.</li>
        <li><strong>Grievance.</strong> Write to our Grievance Officer at <a className="link" href="mailto:privacy@elan1.ai">privacy@elan1.ai</a>. We answer within 7 days and resolve within 30. If you are not satisfied you can complain to the Data Protection Board of India.</li>
      </UL>

      <H2 id="security">Security and breaches</H2>
      <P>Data is encrypted in transit and at rest; signing keys are held in hardware security modules from L2. If a breach affects your personal data we tell you and the Data Protection Board without undue delay, and report to CERT-In within 6 hours where its directions require.</P>

      <H2 id="children">Children</H2>
      <P>Elan1 Govern is a business service. We do not knowingly collect data about anyone under 18.</P>

      <H2 id="changes">Changes</H2>
      <P>We date every version of this notice. If a change affects how we use your data, we tell your organisation’s named contact at least 30 days before it applies.</P>
    </>
  );
}

/* ── Cookie policy ──────────────────────────────────────────────────────── */

function Cookies() {
  return (
    <>
      <H2 id="short">In short</H2>
      <P>Elan1 Govern sets no advertising, analytics or third-party cookies, and so asks for no cookie consent. It keeps a few items in your browser’s own storage, and one strictly necessary first-party cookie, that the console needs to work. They stay on your device and are not sent to anyone.</P>

      <H2 id="items">What is kept in your browser</H2>
      <Table caption="Items kept in your browser" head={['Name', 'Kind', 'What it is for', 'How long']} rows={[
        [<span className="font-mono text-[12.5px]">eg:session</span>, 'Local storage', 'Who is signed in and in which organisation', 'Until you sign out, or the session lifetime your organisation sets'],
        [<span className="font-mono text-[12.5px]">eg:keep-signed-in</span>, 'Local storage', 'Whether you ticked “Keep me signed in”', 'Until you sign out'],
        [<span className="font-mono text-[12.5px]">eg_browser_session</span>, 'Cookie (first-party, this site only)', 'Set at each sign-in so that, when you did not tick “Keep me signed in”, closing the browser ends your session. It holds no identifier, only the value 1.', 'Until you close the browser'],
        [<span className="font-mono text-[12.5px]">eg:auth:ended</span>, 'Session storage', 'Marks that you signed out, so other tabs follow', 'Until the tab closes'],
        [<span className="font-mono text-[12.5px]">eg:auth:sso</span>, 'Session storage', 'The one-time state value while a single sign-on is in progress', 'Until the tab closes'],
        [<span className="font-mono text-[12.5px]">eg:ui</span>, 'Local storage', 'Theme, density and sidebar preferences', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:docs-lang</span>, 'Local storage', 'The code language you chose in the developer portal', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:agents:view</span>, 'Local storage', 'Whether the agents list shows as a table or as cards', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:portal:current</span>, 'Local storage', 'Which counterparty, regulator or partner portal session this browser holds (its id only)', '12 hours, or until you sign out of the portal'],
        [<span className="font-mono text-[12.5px]">eg:today:checklist-dismissed:…</span>, 'Local storage', 'That you hid the set-up checklist on Today, for one organisation and level', 'Until “Reset demo data” or you clear it'],
        [<span className="font-mono text-[12.5px]">elan1-govern:auditor-papers:v2:…</span>, 'Local storage', 'An auditor’s working papers for one client: the sample drawn, review notes and results', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">elan1-govern:auditor-papers:…</span>, 'Local storage', 'Working papers an earlier version kept for one client, before they were kept per auditor; read once and copied into the current item', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:state:…</span>, 'Local storage', 'In this demonstration only: the organisation’s records (and the planned maintenance windows), so work survives a reload', '12 hours, or until “Reset demo data”'],
        [<span className="font-mono text-[12.5px]">eg:auth:v1</span>, 'Local storage', 'In this demonstration only: the accounts, organisations and invitations created by sign-up in this browser', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:levels:v1</span>, 'Local storage', 'In this demonstration only: each organisation’s assurance level and its history, so the organisation switcher shows an upgrade', 'Until “Reset demo data”'],
        [<span className="font-mono text-[12.5px]">eg:v5:…</span>, 'Local storage', 'In this demonstration only: the generated record chain for a demonstration organisation, so pages open quickly', 'Replaced every hour; removed by “Reset demo data”'],
        [<span className="font-mono text-[12.5px]">eg:evidence:export-seq:…</span>, 'Local storage', 'In this demonstration only: the running number of each organisation’s evidence exports', 'Until “Reset demo data”'],
        [<span className="font-mono text-[12.5px]">eg:evidence:sent:…</span>, 'Local storage', 'In this demonstration only: the files a fulfilled evidence request sent (one per part, with their manifests and digests), for one organisation and request, so the auditor collects exactly the export that was recorded rather than one rebuilt later. The name ends with the organisation and the request.', 'Until “Reset demo data”, or until the request is no longer in the organisation’s records'],
        [<span className="font-mono text-[12.5px]">eg:data:billing-pilot-stopped:…</span>, 'Local storage', 'In this demonstration only: how many calls the pilot’s usage cap stopped, per organisation', 'Until “Reset demo data”'],
        [<span className="font-mono text-[12.5px]">eg:data:verifier-release:…</span>, 'Local storage', 'In this demonstration only: the files of one offline-verifier release as first built in this browser (test vectors, reference bundles and notes), so every download of that release has the same bytes and checksums', 'Until “Reset demo data” or you clear it'],
        [<span className="font-mono text-[12.5px]">eg:dr-count</span>, 'Local storage', 'In this demonstration only: the running number of defect reports on the Action Receipt standard sent from the developer portal, used to number the next report', 'Until you clear it'],
        [<span className="font-mono text-[12.5px]">eg:gov-local-assessments</span>, 'Local storage', 'Assessment drafts an earlier version kept in the browser; read once and moved into the organisation’s records', 'Removed once moved'],
      ]} />
      <P>The service worker that lets the console be installed on a phone keeps a copy of the console’s own start page, icons and program files (its scripts and stylesheets) so it can open when you are offline and show a screen that explains what still works. It keeps no records, approvals or receipts and no personal data.</P>

      <H2 id="control">How to remove them</H2>
      <P>Sign out to remove the session items. Your browser’s settings can clear the rest at any time; you will then need to sign in again and set your preferences again.</P>

      <H2 id="change">If this changes</H2>
      <P>If we ever add a cookie that is not strictly necessary, we will ask first, with “Decline” as prominent as “Accept”, and list it here before it is set.</P>
    </>
  );
}

/* ── Sub-processors ─────────────────────────────────────────────────────── */

export const SUB_PROCESSORS: { name: string; entity: string; purpose: string; data: string; location: string; levels: string; when: string }[] = [
  { name: 'Amazon Web Services', entity: 'Amazon Web Services India Private Limited', purpose: 'Hosting, database, object storage with Object Lock, key management (KMS and CloudHSM), backups', data: 'Everything hosted Elan1 Govern stores for your organisation, encrypted', location: 'India: ap-south-1 (Mumbai); backups ap-south-2 (Hyderabad)', levels: 'L1, L2, L3 (hosted)', when: 'Always' },
  { name: 'Amazon Simple Email Service', entity: 'Amazon Web Services India Private Limited', purpose: 'Approval links, sign-in links and notices by email', data: 'Recipient address, the message (a headline and a single-use link; no arguments)', location: 'India: ap-south-1 (Mumbai)', levels: 'L1, L2, L3 (hosted)', when: 'While email notifications are on' },
  { name: 'eMudhra', entity: 'eMudhra Limited', purpose: 'RFC 3161 timestamps for each batch of receipts', data: 'A 32-byte Merkle root only; no personal data', location: 'India', levels: 'L2, L3 (hosted)', when: 'Every batch' },
  { name: 'DigiCert', entity: 'DigiCert, Inc.', purpose: 'The second, global RFC 3161 timestamp for each batch', data: 'A 32-byte Merkle root only; no personal data', location: 'United States (global service)', levels: 'L2, L3 (hosted)', when: 'Every batch' },
  { name: 'Slack', entity: 'Slack Technologies, LLC', purpose: 'A message to each approver about a held action, with a single-use link to the decision page; on rules marked approvable in chat, Approve and Reject buttons as well', data: 'The approver’s confirmed Slack email, the headline and the rule’s reason (no arguments), a link; if a button is used, the decision and who made it', location: 'As set for your Slack workspace', levels: 'L1, L2, L3 (hosted)', when: 'Only if your organisation connects Slack' },
  { name: 'WhatsApp Business Platform', entity: 'Meta Platforms Ireland Limited', purpose: 'A message to each approver about a held action, with a single-use link to the decision page; on rules marked approvable in chat, Approve and Reject buttons as well', data: 'The approver’s number, the headline and the rule’s reason (no arguments), a link; if a button is used, the decision and the approver’s number', location: 'Global', levels: 'L1, L2, L3 (hosted)', when: 'Only for people who verify their number' },
];

function SubProcessors() {
  return (
    <>
      <H2 id="list">Current list</H2>
      <Table caption="Sub-processors" head={['Sub-processor', 'Purpose', 'Data it receives', 'Location', 'Used for', 'When']} rows={SUB_PROCESSORS.map((s) => [
        <span key="n"><span className="block">{s.name}</span><span className="block text-xs font-normal text-muted">{s.entity}</span></span>, s.purpose, s.data, s.location, s.levels, s.when,
      ])} />
      <P>Your organisation’s records are stored and processed in India: AWS in Mumbai, with backups in Hyderabad, and email through Amazon SES in Mumbai. Three services above can be outside India. DigiCert, in the United States, receives only a 32-byte Merkle root for each batch, never personal data. Slack and WhatsApp process the messages they carry where their own services run; they are off until your organisation switches them on, and each person links or verifies their own account.</P>

      <H2 id="sovereign">Sovereign deployments</H2>
      <P>A Sovereign deployment runs on your own infrastructure with egress denied. It uses none of the companies above: your own HSM and timestamp authorities replace AWS KMS, eMudhra and DigiCert, approval emails go through your own mail relay, and Slack and WhatsApp are not available. Usage leaves your network only as a signed statement on media that you hand to us.</P>

      <H2 id="changes">Changes to this list</H2>
      <UL>
        <li>We tell your organisation’s named contact at least 30 days before a new sub-processor starts receiving your data.</li>
        <li>You can object in that time. If we cannot address the objection, you can end the affected service without a penalty and export every record as a verifiable evidence bundle.</li>
        <li>Each sub-processor is bound by a written contract with data-protection terms at least as strict as our DPA.</li>
      </UL>
    </>
  );
}
