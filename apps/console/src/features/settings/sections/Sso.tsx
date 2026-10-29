import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock3, FileUp, Globe, KeyRound, Plug, Plus, RefreshCw, Save, ShieldCheck, Trash2, Users, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useQuery, useMutation } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import { sha256Hex } from '@/lib/crypto';
import { date, dateTime, n, relative } from '@/lib/format';
import type { IdentityConfig, Role } from '@/types';
import { Badge, Banner, Button, CodeBlock, CopyButton, Dialog, EmptyState, Field, IconButton, Input, Panel, Select, Skeleton, StatusChip, Switch, Tabs, Textarea, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { PasswordInput } from '@/features/auth/password';
import { breakGlassOwners, samlRequired } from '@/features/auth/signInPolicy';
import { userById } from '@/mock/users';
import { ReadOnlyNote, SectionHeader, SettingRow, errText, receiptNote } from '../shared';
import { PROVIDER_LABEL, issuerPlaceholder, orgApi, redirectUri, consoleHost, ssoIssuerProblem, type OidcProvider } from '../orgApi';
import { isSovereign } from '@/mock/sovereign';
import { samlEgressProblem } from '@/mock/platform';

const HINTS: Record<OidcProvider, string> = {
  okta: 'Okta admin → Applications → Create app integration → OIDC, Web application.',
  entra: 'Entra admin centre → App registrations → New registration; add the redirect URI as a Web platform.',
  google: 'Google Cloud console → APIs and services → Credentials → OAuth client ID, Web application.',
  keycloak: 'Keycloak admin → your realm → Clients → Create client (OpenID Connect, confidential).',
};

type Tab = 'oidc' | 'saml' | 'scim';

/** Read-only value for roles without settings.security: plain text, not a disabled control. */
function OnOff({ on, extra }: { on: boolean; extra?: string }) {
  return <p className="text-sm">{on ? <span className="font-medium">On</span> : <span className="text-muted">Off</span>}{on && extra ? <span className="text-muted"> · {extra}</span> : null}</p>;
}

export function SsoSection() {
  const orgId = useOrgId();
  const role = useRole();
  const canEdit = useCan('settings.security');
  const [tab, setTab] = useState<Tab>('oidc');
  const { data: oidc } = useQuery((o) => orgApi.oidc(o), [], { kinds: ['sso'] });
  const { data: idc } = useQuery((o) => api.identityConfig(o), [], { kinds: ['receipt'] });

  const verified = oidc?.domains.filter((d) => d.verified) ?? [];
  const status = !oidc?.savedAt && !idc?.saml.enabled ? 'none' : oidc?.ssoOnly || idc?.saml.enforced ? 'enforced' : verified.length || idc?.saml.enabled ? 'active' : 'pending';

  return (
    <div>
      <SectionHeader
        title="Single sign-on"
        description="How people sign in: OpenID Connect or SAML 2.0 through your identity provider, and SCIM to create and remove members from your directory. Every change is a receipt."
        marks={
          status === 'enforced' ? <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>SSO required</StatusChip>
          : status === 'active' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Active</StatusChip>
          : status === 'pending' ? <StatusChip tone="held" size="sm" icon={<Clock3 className="h-3 w-3" />}>Waiting for a verified domain</StatusChip>
          : <StatusChip tone="neutral" size="sm" icon={<XCircle className="h-3 w-3" />}>Not connected</StatusChip>
        }
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners" />}
      <Tabs<Tab>
        label="Sign-in protocols"
        value={tab}
        onChange={setTab}
        className="mb-6"
        items={[
          { value: 'oidc', label: 'OpenID Connect' },
          { value: 'saml', label: <span className="inline-flex items-center gap-1.5">SAML 2.0{idc?.saml.enabled && <CheckCircle2 className="h-3.5 w-3.5 text-ok-fg" aria-label="on" />}</span> },
          { value: 'scim', label: <span className="inline-flex items-center gap-1.5">SCIM provisioning{idc?.scim.enabled && <CheckCircle2 className="h-3.5 w-3.5 text-ok-fg" aria-label="on" />}</span> },
        ]}
      />
      {tab === 'oidc' && <OidcPanel canEdit={canEdit} />}
      {tab === 'saml' && <SamlPanel canEdit={canEdit} config={idc} orgId={orgId} />}
      {tab === 'scim' && <ScimPanel canEdit={canEdit} config={idc} />}
    </div>
  );
}

/* ── OpenID Connect ───────────────────────────────────────────────────── */

function OidcPanel({ canEdit }: { canEdit: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const { data: s, loading, error, refetch } = useQuery((o) => orgApi.oidc(o), [], { kinds: ['sso'] });
  const [form, setForm] = useState<{ provider: OidcProvider; issuer: string; clientId: string }>();
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [tried, setTried] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [domainErr, setDomainErr] = useState<string>();
  const [checking, setChecking] = useState<string>();
  const save = useMutation(orgApi.saveOidc);
  const test = useMutation(orgApi.ssoTest);
  useEffect(() => { if (s && !form) setForm({ provider: s.provider, issuer: s.issuer, clientId: s.clientId }); }, [s, form]);

  if (error) return <Banner tone="bad" title="Single sign-on could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading || !s || !form) return <Skeleton className="h-96" />;

  const needSecret = replacing || !s.secretLast4;
  const issuerErr = !/^https:\/\/[^\s/]+\.[^\s]+/.test(form.issuer) && form.issuer !== 'https://accounts.google.com' ? 'Enter the issuer URL, starting with https://.' : undefined;
  const clientErr = form.clientId.trim().length < 6 ? 'Enter the client id from your provider.' : undefined;
  const secretErr = needSecret && secret.length < 8 ? 'Paste the client secret.' : undefined;
  const dirty = form.provider !== s.provider || form.issuer !== s.issuer || form.clientId !== s.clientId || !!secret;
  const verified = s.domains.filter((d) => d.verified);
  const redirect = redirectUri(orgId);
  // Sovereign: deny-all egress — only an identity provider inside the network can be used (orgApi ssoIssuerProblem)
  const sovereign = isSovereign(orgId);
  const egressProblem = ssoIssuerProblem(orgId, form.provider, form.issuer);
  const savedProblem = ssoIssuerProblem(orgId, s.provider, s.issuer);

  const doSave = async () => {
    setTried(true);
    if (issuerErr || clientErr || secretErr || !user) return;
    try {
      const r = await save.mutate(orgId, { ...form, secret: secret || undefined }, user.id);
      setSecret(''); setReplacing(false); setTried(false);
      toast.ok('Connection saved', `${PROVIDER_LABEL[form.provider]}. This console keeps only the secret’s last 4 characters; test the connection next. ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not saved', errText(e)); }
  };
  const doTest = async () => {
    if (!user) return;
    try {
      const r = await test.mutate(orgId, user.id);
      if (r.ok) toast.ok('Connection works', `Discovery, signing keys, client id and redirect URI all checked. ${receiptNote(r.seq)}`);
      else toast.bad('Connection failed', r.checks.find((c) => !c.ok)?.detail);
    } catch (e) { toast.bad('Test could not run', errText(e)); }
  };
  const check = async (name: string) => {
    if (!user) return;
    setChecking(name);
    try {
      const r = await orgApi.verifyDomain(orgId, name, user.id);
      if (r.domain.verified) toast.ok(`${name} verified`, `The TXT record was found. ${receiptNote(r.seq!)}`);
      else if (r.domain.lastCheck === 'mismatch') toast.bad(`${name} not verified`, 'A verification record exists but its value does not match. Replace it with the value shown.');
      else toast.bad(`${name} not verified`, `No elan1-govern-verify TXT record at ${name}. Publish it and check again — DNS can take up to an hour to update.`);
    } catch (e) { toast.bad('Check failed', errText(e)); } finally { setChecking(undefined); }
  };
  const addDomain = async () => {
    if (!user) return;
    try { const r = await orgApi.addDomain(orgId, newDomain, user.id); setNewDomain(''); setDomainErr(undefined); toast.ok('Domain added', `Publish the TXT record, then check DNS. ${receiptNote(r.seq)}`); }
    catch (e) { setDomainErr(errText(e)); }
  };
  const removeDomain = async (name: string) => {
    if (!user) return;
    try { const r = await orgApi.removeDomain(orgId, name, user.id); toast.ok(`${name} removed`, receiptNote(r.seq)); } catch (e) { toast.bad('Not removed', errText(e)); }
  };
  const setSsoOnly = async (on: boolean) => {
    if (!user) return;
    try {
      const r = await orgApi.setSsoOnly(orgId, on, user.id);
      if (on) toast.held('SSO-only is on', `The sign-in page sends people on ${r.domains.join(', ')} to ${PROVIDER_LABEL[s.provider]} and refuses their passwords. ${receiptNote(r.seq)}`);
      else toast.ok('SSO-only is off', `People can sign in with a password again. ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const setJit = async (patch: { jit?: boolean; jitRole?: Role }) => {
    if (!user) return;
    try { const r = await orgApi.setJit(orgId, patch, user.id); toast.ok('Just-in-time accounts updated', receiptNote(r.seq)); } catch (e) { toast.bad('Not changed', errText(e)); }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <div className="xl:col-span-8 space-y-6 min-w-0">
        {sovereign && (
          <Banner tone={egressProblem ? 'bad' : 'info'} title={egressProblem ? 'Outside your network: refused under deny-all egress' : 'Deny-all egress: an identity provider inside your network'}>
            {egressProblem ?? 'This Sovereign deployment sends nothing to the internet, so single sign-on uses Keycloak or another identity provider inside the network: an issuer on .internal, .local, .lan, a private address or your own domain.'}
            {' '}Okta, Microsoft Entra ID and Google Workspace are cloud services: saving or testing one is refused before anything is sent, and the attempt is recorded as egress.blocked in the egress log.
          </Banner>
        )}
        <Panel title="OIDC connection" kicker="Step 1" actions={s.savedAt && <span className="text-xs text-muted">Saved {relative(s.savedAt)}</span>}
          footer={canEdit && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" icon={<Plug className="h-4 w-4" />} loading={test.pending} onClick={doTest} disabled={!s.savedAt || dirty} title={!s.savedAt ? 'Save the connection first.' : dirty ? 'Save your changes first.' : savedProblem ? `${savedProblem} Testing it is refused and recorded.` : undefined}>Test connection</Button>
              <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.pending} onClick={doSave} disabled={!dirty && !!s.savedAt}>Save connection</Button>
            </div>
          )}>
          <SettingRow label="Provider" htmlFor={canEdit ? 'sso-provider' : undefined} help={HINTS[form.provider]}>
            {canEdit ? (
              <Select id="sso-provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as OidcProvider })}>
                {(Object.keys(PROVIDER_LABEL) as OidcProvider[]).map((k) => <option key={k} value={k}>{PROVIDER_LABEL[k]}{sovereign && k !== 'keycloak' ? ' (outside your network)' : ''}</option>)}
              </Select>
            ) : <p className="text-sm font-medium">{s.savedAt ? PROVIDER_LABEL[s.provider] : <span className="text-muted font-normal">Not connected</span>}</p>}
          </SettingRow>
          <SettingRow label="Issuer URL" htmlFor={canEdit ? 'sso-issuer' : undefined} help="The provider’s discovery document must be at this URL plus /.well-known/openid-configuration.">
            {canEdit ? (
              <Field error={tried ? issuerErr : undefined}>
                <Input id="sso-issuer" mono value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value.trim() })} placeholder={issuerPlaceholder(orgId, form.provider)} invalid={tried && !!issuerErr} />
              </Field>
            ) : <p className="font-mono text-[12.5px] break-all">{s.issuer || <span className="font-sans text-sm text-muted">Not set</span>}</p>}
          </SettingRow>
          <SettingRow label="Client id" htmlFor={canEdit ? 'sso-client' : undefined}>
            {canEdit ? (
              <Field error={tried ? clientErr : undefined}>
                <Input id="sso-client" mono value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="0oa8f3k2m1XyZ5d7" invalid={tried && !!clientErr} />
              </Field>
            ) : <p className="font-mono text-[12.5px] break-all">{s.clientId || <span className="font-sans text-sm text-muted">Not set</span>}</p>}
          </SettingRow>
          <SettingRow label="Client secret" htmlFor={canEdit && needSecret ? 'sso-secret' : undefined} help="Visible while you type. After saving, this console shows only its last 4 characters.">
            {needSecret && !canEdit ? (
              <p className="text-sm text-muted">Not set</p>
            ) : needSecret ? (
              <Field error={tried ? secretErr : undefined}>
                <PasswordInput id="sso-secret" className="font-mono text-sm" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" invalid={tried && !!secretErr} />
              </Field>
            ) : (
              <div className="flex items-center gap-2">
                <span className="h-10 flex-1 inline-flex items-center px-3 border border-line bg-sunken font-mono text-sm">••••••••••••{s.secretLast4}</span>
                {canEdit && <Button variant="secondary" onClick={() => setReplacing(true)}>Replace</Button>}
              </div>
            )}
          </SettingRow>
          <SettingRow label="Redirect URI" help={`Add this exactly in your provider. It is on ${consoleHost(orgId).replace('https://', '')}, where this organisation’s console answers. PKCE, state and nonce are always on.`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-[12.5px] truncate" title={redirect}>{redirect}</span>
              <CopyButton text={redirect} />
            </div>
          </SettingRow>
        </Panel>

        {s.test && (
          <Panel title="Last test" actions={s.test.ok ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Passed</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Failed</StatusChip>} flush>
            <ul className="divide-y divide-line">
              {s.test.checks.map((c) => (
                <li key={c.label} className="flex items-start gap-3 px-5 py-3 text-sm">
                  {c.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-ok-fg shrink-0" aria-label="Passed" /> : <XCircle className="h-4 w-4 mt-0.5 text-bad-fg shrink-0" aria-label="Failed" />}
                  <span className="min-w-0"><span className="font-medium">{c.label}</span><span className="block text-xs text-muted break-words">{c.detail}</span></span>
                </li>
              ))}
            </ul>
            <p className="px-5 py-2.5 border-t border-line text-xs text-muted">Tested {dateTime(s.test.at)}</p>
          </Panel>
        )}

        <Panel title="Domains" kicker="Step 2" flush>
          <div className="p-5 border-b border-line text-sm text-muted">Prove you control each email domain by publishing a DNS TXT record. Only people on verified domains are sent to your provider.</div>
          <ul className="divide-y divide-line">
            {s.domains.map((d) => {
              const recordText = `elan1-govern-verify=${d.token}`;
              return (
                <li key={d.name} className="p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <Globe className="h-4 w-4 text-muted" aria-hidden />
                    <span className="font-mono text-sm font-medium break-all">{d.name}</span>
                    {d.verified
                      ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Verified</StatusChip>
                      : d.lastCheck ? <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>{d.lastCheck === 'mismatch' ? 'Record does not match' : 'Record not found'}</StatusChip>
                        : <StatusChip tone="held" size="sm" icon={<Clock3 className="h-3 w-3" />}>Waiting for DNS</StatusChip>}
                    {d.checkedAt && <span className="text-xs text-muted">Checked {relative(d.checkedAt)}</span>}
                    <span className="ml-auto flex items-center gap-1">
                      {canEdit && !d.verified && <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={checking === d.name} onClick={() => check(d.name)}>Check DNS</Button>}
                      {canEdit && <IconButton label={`Remove ${d.name}`} size="sm" disabled={s.ssoOnly && d.verified && verified.length === 1} title={s.ssoOnly && d.verified && verified.length === 1 ? 'The only verified domain while SSO-only is on' : `Remove ${d.name}`} onClick={() => removeDomain(d.name)}><Trash2 className="h-4 w-4" /></IconButton>}
                    </span>
                  </div>
                  {!d.verified && <CodeBlock className="mt-3" title="DNS TXT record" code={`Type   TXT\nHost   @   (${d.name})\nValue  ${recordText}\nTTL    3600`} />}
                </li>
              );
            })}
            {s.domains.length === 0 && <li className="p-5 text-sm text-muted">No domains. Add the domain your people sign in with.</li>}
          </ul>
          {canEdit && (
            <div className="p-5 border-t border-line flex flex-wrap items-start gap-2">
              <Field className="flex-1 min-w-[200px]" error={domainErr}>
                <Input aria-label="Add a domain" mono value={newDomain} onChange={(e) => { setNewDomain(e.target.value); setDomainErr(undefined); }} onKeyDown={(e) => e.key === 'Enter' && addDomain()} placeholder="company.com" invalid={!!domainErr} />
              </Field>
              <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={addDomain}>Add domain</Button>
            </div>
          )}
        </Panel>

        <Panel title="Enforcement and provisioning" kicker="Step 3">
          <SettingRow label="SSO-only" help={!s.savedAt ? 'Save the connection first.' : !verified.length ? 'Verify at least one domain first.' : 'The sign-in page sends people on verified domains to your provider and refuses their passwords.'}>
            {canEdit
              ? <Switch label="Require SSO for verified domains" checked={s.ssoOnly} disabled={!s.savedAt || !verified.length} onChange={setSsoOnly} />
              : <OnOff on={s.ssoOnly} />}
            {s.ssoOnly && <Banner tone="held" className="mt-3" title="Keep a way back in">If your provider is down, nobody on these domains can sign in — including to engage the emergency stop. Keep one owner on a domain that is not enforced, with a password and two-step sign-in, as a break-glass account.</Banner>}
          </SettingRow>
          <SettingRow label="Create users on first sign-in" help="Just-in-time accounts for people your provider lets through. They start with the role below; an owner or admin promotes them.">
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-3">
                <Switch label="Just-in-time user creation" checked={s.jit} onChange={(v) => setJit({ jit: v })} />
                <Select size_="sm" aria-label="Role for new users" value={s.jitRole} disabled={!s.jit} onChange={(e) => setJit({ jitRole: e.target.value as Role })} className="w-40">
                  {(['viewer', 'approver'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                </Select>
              </div>
            ) : <OnOff on={s.jit} extra={`new users start as ${ROLE_INFO[s.jitRole].label}`} />}
          </SettingRow>
        </Panel>
      </div>

      <div className="xl:col-span-4 space-y-6 min-w-0">
        <Panel title="How sign-in works">
          <ol className="space-y-3 text-sm">
            {[
              'A person enters their work email on the sign-in page.',
              'If the domain is verified, they are sent to your provider with PKCE.',
              'Elan1 Govern checks the ID token’s issuer, audience, nonce and signature.',
              'The session starts; new people are created with the default role if just-in-time is on.',
            ].map((t, i) => (
              <li key={i} className="flex gap-3"><span className="h-5 w-5 shrink-0 inline-flex items-center justify-center border border-line-strong text-[11px] font-semibold num">{i + 1}</span><span className="text-muted">{t}</span></li>
            ))}
          </ol>
          {s.test?.ok && <p className="mt-4 text-xs text-ok-fg inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Last test passed {relative(s.test.at)}</p>}
        </Panel>
        <SignInPreview />
      </div>
    </div>
  );
}

/** What the sign-in page does for an email, from the saved configuration. */
function SignInPreview() {
  const orgId = useOrgId();
  const user = useUser();
  const [email, setEmail] = useState(user?.email ?? '');
  useQuery((o) => orgApi.oidc(o), [], { kinds: ['sso'] });
  const r = /@/.test(email) ? orgApi.signInRoute(orgId, email) : undefined;
  return (
    <Panel title="Try an email">
      <Field label="Work email" htmlFor="sso-try">
        <Input id="sso-try" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
      </Field>
      {r && (
        <p className="mt-3 text-sm">
          {r.route === 'password' ? 'Signs in with a password and two-step code — the domain is not verified for SSO.'
            : r.route === 'sso' ? <>Sent to <span className="font-mono text-[12.5px] break-all">{r.issuer}</span>. A password still works.</>
              : <>Sent to <span className="font-mono text-[12.5px] break-all">{r.issuer}</span>. Passwords are refused.</>}
        </p>
      )}
      {r && r.route !== 'sso_only' && samlRequired(orgId).required && (
        <p className="mt-2 text-sm text-held-fg">SAML is required in this organisation: a password for one of its own addresses is refused unless it belongs to a break-glass owner with two-step sign-in.</p>
      )}
    </Panel>
  );
}

/* ── SAML 2.0 ─────────────────────────────────────────────────────────── */

interface ParsedMetadata { entityId: string; ssoUrl: string; certB64: string; fingerprint: string; expiresAt?: string }

/** Read an IdP metadata document: entity id, SSO URL (HTTP-Redirect or POST) and the signing certificate. */
function parseMetadata(xml: string): ParsedMetadata {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That is not well-formed XML.');
  const byLocal = (name: string) => Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === name);
  const ed = byLocal('EntityDescriptor')[0];
  if (!ed) throw new Error('No EntityDescriptor found. Paste the identity provider’s metadata, not the service provider’s.');
  if (!byLocal('IDPSSODescriptor').length) throw new Error('No IDPSSODescriptor found — this metadata does not describe an identity provider.');
  const sso = byLocal('SingleSignOnService').find((e) => /HTTP-(Redirect|POST)/.test(e.getAttribute('Binding') ?? ''));
  if (!sso) throw new Error('No SingleSignOnService with the HTTP-Redirect or HTTP-POST binding.');
  const cert = byLocal('X509Certificate')[0]?.textContent?.replace(/\s+/g, '');
  if (!cert) throw new Error('No signing certificate (X509Certificate) in the metadata.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(cert), (c) => c.charCodeAt(0)); } catch { throw new Error('The certificate is not valid base64.'); }
  // validity: the second UTCTime (tag 0x17) in the certificate is notAfter
  const times: string[] = [];
  for (let i = 0; i < bytes.length - 15 && times.length < 2; i++) {
    if (bytes[i] === 0x17 && bytes[i + 1] === 13) { times.push(String.fromCharCode(...bytes.slice(i + 2, i + 15))); i += 14; }
  }
  const na = times[1];
  const expiresAt = na && /^\d{12}Z$/.test(na) ? new Date(Date.UTC(2000 + Number(na.slice(0, 2)), Number(na.slice(2, 4)) - 1, Number(na.slice(4, 6)), Number(na.slice(6, 8)), Number(na.slice(8, 10)), Number(na.slice(10, 12)))).toISOString() : undefined;
  const fp = sha256Hex(cert).slice(0, 40).toUpperCase().replace(/(..)(?!$)/g, '$1:');
  return { entityId: ed.getAttribute('entityID') ?? '', ssoUrl: sso.getAttribute('Location') ?? '', certB64: cert, fingerprint: fp, expiresAt };
}

/** Who can still sign in with a password while SAML is required: owners with two-step sign-in (break-glass). */
function BreakGlassNote({ orgId, enforced }: { orgId: string; enforced: boolean }) {
  const owners = breakGlassOwners(orgId);
  if (!owners.length) {
    return <Banner tone="bad" className="mt-3" title="No break-glass owner">No owner has two-step sign-in, so {enforced ? 'if the identity provider is down nobody can sign in — including to engage the emergency stop' : 'requiring SAML would leave no way in if the identity provider is down'}. Have an owner enrol an authenticator on the You page.</Banner>;
  }
  return (
    <p className="mt-3 text-xs text-muted">
      {enforced ? 'Passwords are refused now. ' : 'When required, passwords are refused. '}
      Break-glass: {owners.map((id) => userById(id)?.name ?? id).join(', ')} {owners.length === 1 ? 'keeps' : 'keep'} a password with two-step sign-in; each such sign-in is recorded as break-glass on its receipt.
    </p>
  );
}

function SamlPanel({ canEdit, config, orgId }: { canEdit: boolean; config?: IdentityConfig; orgId: string }) {
  const user = useUser();
  const [xml, setXml] = useState('');
  const [parsed, setParsed] = useState<ParsedMetadata>();
  const [parseErr, setParseErr] = useState<string>();
  const [idp, setIdp] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const save = useMutation(api.setIdentityConfig);
  if (!config) return <Skeleton className="h-96" />;
  const saml = config.saml;
  const expiresSoon = new Date(saml.certExpiresAt).getTime() - Date.now() < 30 * 864e5;

  const readXml = (text: string) => {
    setXml(text);
    if (!text.trim()) { setParsed(undefined); setParseErr(undefined); return; }
    try { const p = parseMetadata(text); setParsed(p); setParseErr(undefined); if (!idp) setIdp(guessIdp(p.ssoUrl)); }
    catch (e) { setParsed(undefined); setParseErr(errText(e)); }
  };
  const apply = async (patch: Partial<IdentityConfig['saml']>, what: string) => {
    if (!user) return;
    try { await save.mutate(orgId, { saml: patch }, user.id); toast.ok(what, 'Recorded as an identity.updated receipt.'); }
    catch (e) { toast.bad('Not saved', errText(e)); }
  };
  // Sovereign: deny-all egress — SAML only from an identity provider inside the network (mock/platform samlEgressProblem)
  const sov = isSovereign(orgId);
  const savedProblem = samlEgressProblem(orgId, saml.idp, saml.metadataUrl);
  const newProblem = parsed ? samlEgressProblem(orgId, idp || guessIdp(parsed.ssoUrl), parsed.ssoUrl) : undefined;
  const useMetadata = async () => {
    if (!parsed) return;
    await apply({ idp: idp || guessIdp(parsed.ssoUrl), metadataUrl: parsed.ssoUrl, certFingerprint: parsed.fingerprint, certExpiresAt: parsed.expiresAt ?? saml.certExpiresAt, enabled: true }, 'Identity provider metadata saved');
    setXml(''); setParsed(undefined);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <div className="xl:col-span-8 space-y-6 min-w-0">
        {sov && (
          <Banner tone={savedProblem ? 'bad' : 'info'} title={savedProblem ? 'This identity provider is outside your network' : 'Only an identity provider inside your network'}>
            {savedProblem
              ? <>{savedProblem.why} SAML cannot be switched on or required with it. Save metadata from Keycloak or another provider inside the network.</>
              : <>This deployment denies all egress, so SAML works only with a provider inside the network: Keycloak, ADFS, or another provider whose metadata is on .internal, .local, .lan, a private address or your own domain. Okta, Entra ID, Google Workspace and other cloud providers are refused, and each attempt is recorded as egress.blocked.</>}
          </Banner>
        )}
        <Panel title="SAML 2.0 connection" actions={saml.enabled ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>On</StatusChip> : <StatusChip tone="neutral" size="sm" icon={<XCircle className="h-3 w-3" />}>Off</StatusChip>}>
          <SettingRow label="SAML sign-in" help="For providers without OpenID Connect, or where your security team requires SAML.">
            {canEdit
              ? <Switch label="SAML sign-in" checked={saml.enabled} disabled={save.pending} onChange={(v) => apply({ enabled: v, ...(v ? {} : { enforced: false }) }, v ? 'SAML sign-in on' : 'SAML sign-in off')} />
              : <OnOff on={saml.enabled} />}
          </SettingRow>
          <SettingRow label="Identity provider" help="Read from the metadata you saved.">
            <p className="text-sm font-medium">{saml.idp}</p>
            <p className="mt-1 font-mono text-[12px] text-muted break-all">{saml.metadataUrl}</p>
          </SettingRow>
          <SettingRow label="Signing certificate" help="SHA-256 fingerprint of the provider’s certificate. Assertions signed with any other key are refused.">
            <p className="font-mono text-[12px] break-all">{saml.certFingerprint}</p>
            <p className={`mt-1 text-xs ${expiresSoon ? 'text-held-fg' : 'text-muted'}`}>Expires {date(saml.certExpiresAt)} ({relative(saml.certExpiresAt)}){expiresSoon && ' — upload the new metadata before then'}</p>
          </SettingRow>
          <SettingRow label="Require SAML" help="People with the organisation’s own addresses must sign in through the provider; their passwords are refused, on the sign-in page and on approval links. Owners with two-step sign-in keep a password as the break-glass way in. External auditors are not in your directory and keep theirs.">
            {canEdit
              ? <Switch label="Require SAML for everyone" checked={saml.enforced} disabled={!saml.enabled || save.pending} onChange={(v) => apply({ enforced: v }, v ? 'SAML required' : 'SAML no longer required')} />
              : <OnOff on={saml.enforced} />}
            <BreakGlassNote orgId={orgId} enforced={saml.enforced} />
          </SettingRow>
          <SettingRow label="Create users on first sign-in" help="Accounts are created from the assertion’s email and group attributes; SCIM keeps them in step afterwards.">
            {canEdit
              ? <Switch label="Just-in-time provisioning" checked={saml.jitProvisioning} disabled={!saml.enabled || save.pending} onChange={(v) => apply({ jitProvisioning: v }, 'Just-in-time provisioning updated')} />
              : <OnOff on={saml.jitProvisioning} />}
          </SettingRow>
          {saml.lastLoginAt && <p className="pt-3 text-xs text-muted">Last SAML sign-in {relative(saml.lastLoginAt)}.</p>}
        </Panel>

        {/* Uploading metadata is an edit: roles without settings.security do not see this panel. */}
        {canEdit && <Panel title="Identity provider metadata" kicker="Upload or paste">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input ref={fileRef} type="file" accept=".xml,application/xml,text/xml" className="sr-only" aria-label="Metadata file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) readXml(await f.text()); e.target.value = ''; }} />
            <Button variant="secondary" size="sm" icon={<FileUp className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Upload metadata XML</Button>
            <span className="text-xs text-muted">or paste it below</span>
          </div>
          <Textarea aria-label="Identity provider metadata XML" rows={6} className="font-mono text-[12px]" value={xml} onChange={(e) => readXml(e.target.value)} placeholder={'<md:EntityDescriptor entityID="…">\n  <md:IDPSSODescriptor …>'} invalid={!!parseErr} />
          {parseErr && <p className="mt-2 text-xs text-bad-fg" role="alert">{parseErr}</p>}
          {parsed && (
            <div className="mt-4 border border-line">
              <dl className="divide-y divide-line text-sm">
                {[['Entity id', parsed.entityId], ['Sign-in URL', parsed.ssoUrl], ['Certificate fingerprint', parsed.fingerprint], ['Certificate expires', parsed.expiresAt ? date(parsed.expiresAt) : 'Not readable — check it in your provider']].map(([k, v]) => (
                  <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[180px_minmax(0,1fr)]"><dt className="text-muted">{k}</dt><dd className="font-mono text-[12px] break-all">{v}</dd></div>
                ))}
              </dl>
              <div className="flex flex-wrap items-end gap-2 border-t border-line p-4">
                <Field label="Provider name" htmlFor="saml-idp" className="flex-1 min-w-[180px]"><Input id="saml-idp" value={idp} onChange={(e) => setIdp(e.target.value)} /></Field>
                <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.pending} onClick={useMetadata}>Use this metadata</Button>
              </div>
              {newProblem && <p className="border-t border-line px-4 py-3 text-xs text-bad-fg" role="alert">{newProblem.why} Saving it is refused and recorded as egress.blocked.</p>}
            </div>
          )}
        </Panel>}
      </div>

      <div className="xl:col-span-4 space-y-6 min-w-0">
        <Panel title="Give your provider these">
          <dl className="space-y-4 text-sm">
            <div><dt className="label">Entity id (audience)</dt><dd className="mt-1 flex items-center gap-1 min-w-0"><span className="font-mono text-[12px] break-all">{saml.entityId}</span><CopyButton text={saml.entityId} compact label="Copy entity id" /></dd></div>
            <div><dt className="label">ACS URL (HTTP-POST)</dt><dd className="mt-1 flex items-center gap-1 min-w-0"><span className="font-mono text-[12px] break-all">{saml.acsUrl}</span><CopyButton text={saml.acsUrl} compact label="Copy ACS URL" /></dd></div>
            <div><dt className="label">Name id</dt><dd className="mt-1">Email address</dd></div>
            <div><dt className="label">Attributes</dt><dd className="mt-1 font-mono text-[12px]">email, name, groups</dd></div>
          </dl>
          <p className="mt-4 text-xs text-muted">Assertions must be signed; we check the signature, audience, recipient, NotOnOrAfter and that each assertion id is used once.</p>
        </Panel>
      </div>
    </div>
  );
}

function guessIdp(url: string) {
  return /okta/.test(url) ? 'Okta' : /microsoftonline|windows\.net/.test(url) ? 'Microsoft Entra ID' : /google/.test(url) ? 'Google Workspace' : /realms\//.test(url) ? 'Keycloak' : /onelogin/.test(url) ? 'OneLogin' : 'SAML identity provider';
}

/* ── SCIM 2.0 ─────────────────────────────────────────────────────────── */

const SCIM_ACTIONS = /^(identity\.|member\.(invited|removed|role_changed|suspended|reinstated|invite_accepted))/;

function ScimPanel({ canEdit, config }: { canEdit: boolean; config?: IdentityConfig }) {
  const orgId = useOrgId();
  const user = useUser();
  const save = useMutation(api.setIdentityConfig);
  const rotate = useMutation(api.rotateScimToken);
  const [secret, setSecret] = useState<string>();
  const { data: members } = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const { data: log, loading: logLoading } = useQuery(async (o) => (await api.receipts(o, { kind: 'admin', from: Date.now() - 30 * 864e5 })).items.filter((r) => SCIM_ACTIONS.test(r.action ?? '')).slice(0, 40), [], { kinds: ['receipt'] });
  const provisioned = useMemo(() => (members ?? []).filter((m) => m.status !== 'invited' && m.role !== 'auditor'), [members]);
  if (!config) return <Skeleton className="h-96" />;
  const scim = config.scim;

  const apply = async (patch: Partial<IdentityConfig['scim']>, what: string) => {
    if (!user) return;
    try { await save.mutate(orgId, { scim: patch }, user.id); toast.ok(what, 'Recorded as an identity.updated receipt.'); } catch (e) { toast.bad('Not saved', errText(e)); }
  };
  const newToken = async () => {
    if (!user) return;
    try { const r = await rotate.mutate(orgId, user.id); setSecret(r.secret); } catch (e) { toast.bad('No new token', errText(e)); }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-12">
      <div className="xl:col-span-8 space-y-6 min-w-0">
        <Panel title="SCIM 2.0 provisioning" actions={scim.enabled ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>On</StatusChip> : <StatusChip tone="neutral" size="sm" icon={<XCircle className="h-3 w-3" />}>Off</StatusChip>}>
          <SettingRow label="Provisioning" help="Your directory creates, updates and deactivates members. A deactivated person’s sessions end at once; their receipts stay.">
            {canEdit
              ? <Switch label="SCIM provisioning" checked={scim.enabled} disabled={save.pending} onChange={(v) => apply({ enabled: v }, v ? 'SCIM provisioning on' : 'SCIM provisioning off')} />
              : <OnOff on={scim.enabled} />}
          </SettingRow>
          <SettingRow label="Base URL" help="Users and Groups endpoints live under it.">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-[12.5px] truncate" title={scim.endpoint}>{scim.endpoint}</span>
              <CopyButton text={scim.endpoint} />
            </div>
          </SettingRow>
          <SettingRow label="Bearer token" help="Shown once when generated. A new token replaces the old one at once.">
            <div className="flex flex-wrap items-center gap-2">
              <span className="h-10 inline-flex items-center px-3 border border-line bg-sunken font-mono text-sm">{scim.tokenPrefix}••••••••</span>
              {canEdit && <Button variant="secondary" icon={<KeyRound className="h-4 w-4" />} loading={rotate.pending} onClick={newToken}>Generate new token</Button>}
            </div>
          </SettingRow>
          <SettingRow label="Last sync" help="When your directory last called us.">
            <p className="text-sm">{scim.lastSyncAt ? <>{relative(scim.lastSyncAt)} · {dateTime(scim.lastSyncAt)}</> : 'Never — add the base URL and token in your directory.'}</p>
          </SettingRow>
        </Panel>

        <Panel title="Groups to roles" flush footer="The highest role a person’s groups give wins. People in none of these groups are not provisioned.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">Directory groups mapped to roles</caption>
              <thead className="bg-sunken/80"><tr className="border-b border-line"><th scope="col" className="h-10 px-5 text-left label font-semibold">Directory group</th><th scope="col" className="h-10 px-5 text-left label font-semibold">Role</th></tr></thead>
              <tbody>
                {scim.groupMap.map((g, i) => (
                  <tr key={g.idpGroup} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-5 py-2.5 text-left font-mono text-[12.5px] font-normal">{g.idpGroup}</th>
                    <td className="px-5 py-2">
                      {canEdit ? (
                        <Select size_="sm" aria-label={`Role for ${g.idpGroup}`} className="w-40" value={g.role} disabled={save.pending}
                          onChange={(e) => apply({ groupMap: scim.groupMap.map((x, j) => (j === i ? { ...x, role: e.target.value as Role } : x)) }, `${g.idpGroup} now maps to ${ROLE_INFO[e.target.value as Role].label}`)}>
                          {(['owner', 'admin', 'approver', 'viewer'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
                        </Select>
                      ) : <span>{ROLE_INFO[g.role].label}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Provisioning log" kicker="Last 30 days" flush>
          {logLoading && !log ? <div className="p-5"><Skeleton className="h-24" /></div> : !log?.length ? (
            <EmptyState compact title="Nothing provisioned in 30 days" disc="trail">Changes your directory makes, and member changes made here, appear as receipts.</EmptyState>
          ) : (
            <ul className="divide-y divide-line max-h-80 overflow-y-auto">
              {log.map((r) => (
                <li key={r.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                  <span className="font-mono text-[12.5px]">{r.action}</span>
                  <span className="text-xs text-muted min-w-0 flex-1 truncate">{Object.entries(r.details ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}</span>
                  <When iso={r.ts} className="text-xs text-muted" />
                  <ReceiptLink seq={r.seq} className="text-xs" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="xl:col-span-4 space-y-6 min-w-0">
        <Panel title={<span className="inline-flex items-center gap-2"><Users className="h-4 w-4" aria-hidden />Provisioned</span>}>
          <dl className="grid grid-cols-2 gap-4">
            <div><dt className="label">Members</dt><dd className="mt-1 font-display text-2xl font-semibold num">{n(scim.enabled ? Math.max(scim.usersProvisioned, provisioned.length) : provisioned.length)}</dd></div>
            <div><dt className="label">Deprovisioned, 30 days</dt><dd className="mt-1 font-display text-2xl font-semibold num">{n(scim.deprovisioned30d)}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted">Auditors are never provisioned by SCIM; an owner invites them.</p>
        </Panel>
      </div>

      <Dialog open={!!secret} onClose={() => setSecret(undefined)} title="Copy the SCIM token now" description="This is the only time the full token is shown. Paste it into your directory’s provisioning settings."
        footer={<Button variant="primary" onClick={() => setSecret(undefined)}>I have stored it</Button>}>
        {secret && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-[12.5px] truncate">{secret}</span>
              <CopyButton text={secret} label="Copy token" />
            </div>
            <Banner tone="held">The previous token stopped working when this one was generated.</Banner>
            <Badge>Recorded as identity.scim_token_rotated</Badge>
          </div>
        )}
      </Dialog>
    </div>
  );
}
