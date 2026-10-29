import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useOrgId, useRole, useUser } from '@/store/session';
import { useUi, type Density, type Theme } from '@/store/ui';
import { api } from '@/api';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { ROLE_INFO } from '@/lib/permissions';
import { countdown, dateTime, n, pct, relative, rupees, rupeesShort, seqLabel } from '@/lib/format';
import { Avatar, Badge, Banner, Button, CodeBlock, CopyButton, Dialog, Field, Input, Kbd, Panel, Segmented, Switch, toast } from '@/components/ui';
import { PasswordChecklist, PasswordInput, passwordChecks, passwordOk } from '@/features/auth/password';
import { SectionHeader, SettingRow, receiptNote } from '../shared';
import { orgApi } from '../orgApi';
import { SmartLink, useScreenAccess } from '@/shell/access';

export function PreferencesSection() {
  const user = useUser();
  const access = useScreenAccess();
  const role = useRole();
  const orgId = useOrgId();
  const { theme, setTheme, density, setDensity, singleKeyShortcuts, setSingleKeyShortcuts, liveUpdates, setLiveUpdates, setShortcutsOpen } = useUi();
  const org = api.org(orgId);
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const { data: sess } = useQuery((o) => orgApi.sessions(o, user?.id ?? ''), [user?.id], { kinds: ['session', 'member'] });
  const policy = sess?.policy;
  const mfaOn = !!user && orgApi.mfaOn(orgId, user.id);
  const sample = useMemo(() => {
    const now = Date.now();
    return {
      ts: new Date(now - 47 * 60_000).toISOString(),
      expires: new Date(now + (3 * 60 + 12) * 60_000).toISOString(),
    };
  }, []);

  return (
    <div>
      <SectionHeader title="Preferences" description="How the console looks and behaves for you on this browser, and how you sign in. They do not change anything for anyone else." />
      {!mfaOn && policy?.require2step && (
        <Banner tone="held" className="mb-6" title="Your organisation requires two-step sign-in" actions={<Button size="sm" variant="primary" onClick={() => setEnrolOpen(true)}>Set it up now</Button>}>
          Enrol an authenticator app. It takes a minute, and you will be asked for a 6-digit code at each sign-in.
        </Banner>
      )}
      {user && <TotpDialog open={enrolOpen} onClose={() => setEnrolOpen(false)} orgId={orgId} userId={user.id} />}
      {user && <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} orgId={orgId} userId={user.id} />}

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8 space-y-6">
          <Panel title="Appearance">
            <SettingRow label="Theme" help="System follows your device’s light or dark setting.">
              <Segmented<Theme> label="Theme" value={theme} onChange={setTheme} options={[
                { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="h-3.5 w-3.5" aria-hidden />Light</span> },
                { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="h-3.5 w-3.5" aria-hidden />Dark</span> },
                { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="h-3.5 w-3.5" aria-hidden />System</span> },
              ]} />
            </SettingRow>
            <SettingRow label="Density" help="Compact fits more rows in tables such as Activity and Approvals.">
              <Segmented<Density> label="Density" value={density} onChange={setDensity} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
              <div className="mt-3 border border-line" aria-hidden>
                {['#4,812 · invoice-bot · Allowed', '#4,811 · invoice-bot · Asked a person'].map((r) => (
                  <div key={r} className={`flex items-center px-3 border-b border-line last:border-b-0 text-sm ${density === 'compact' ? 'h-9' : 'h-12'}`}><span className="font-mono text-[12.5px]">{r}</span></div>
                ))}
              </div>
            </SettingRow>
          </Panel>

          <Panel title="Keyboard and updates">
            <SettingRow label="Single-key shortcuts" help={<>G then a letter to move between pages{access.canSee('/approvals') ? ', J and K in approvals' : ''}, ? for the list. Ctrl K always works. Nothing irreversible has a single-key shortcut.</>}>
              <div className="flex flex-wrap items-center gap-3">
                <Switch label="Single-key shortcuts" checked={singleKeyShortcuts} onChange={setSingleKeyShortcuts} />
                <button type="button" className="text-sm link" onClick={() => setShortcutsOpen(true)}>Show all shortcuts</button>
              </div>
            </SettingRow>
            <SettingRow label="Live updates" help="New decisions appear as they happen on Today and Activity. Turn off to read a still page; refresh to catch up.">
              <Switch label="Live updates" checked={liveUpdates} onChange={setLiveUpdates} />
            </SettingRow>
          </Panel>

          <Panel title="Dates and numbers" footer={<>Times show in the organisation’s time zone ({org.timezone}); receipts store UTC. Set by an owner or admin in <SmartLink to="/agents/organisation" className="link">Organisation</SmartLink>.</>}>
            <dl className="grid gap-px bg-line border border-line sm:grid-cols-2">
              {[
                ['Amount', rupees(240000)],
                ['Large amount', rupeesShort(12_500_000)],
                ['Count', n(1234567)],
                ['Share', pct(0.184, 1)],
                ['Date and time', dateTime(sample.ts)],
                ['Relative', relative(sample.ts)],
                ['Expiry countdown', countdown(sample.expires)],
                ['Receipt number', seqLabel(48213)],
              ].map(([k, v]) => (
                <div key={k} className="bg-surface px-4 py-3">
                  <dt className="label">{k}</dt>
                  <dd className="mt-1 text-md font-medium num">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">Indian digit grouping, 24-hour time, British English.</p>
          </Panel>
        </div>

        <div className="xl:col-span-4 space-y-6">
          <Panel title="You">
            {user && (
              <>
                <div className="flex items-center gap-3">
                  <Avatar initials={user.initials} size={44} />
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{user.name}</p>
                    <p className="text-sm text-muted truncate">{user.title}</p>
                  </div>
                </div>
                <dl className="mt-4 space-y-2.5 text-sm">
                  <div className="flex justify-between gap-3"><dt className="text-muted">Email</dt><dd className="truncate">{user.email}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Role</dt><dd>{role && <Badge tone="inverse">{ROLE_INFO[role].label}</Badge>}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted">Two-step sign-in</dt><dd>{mfaOn ? 'On' : <span className="text-held-fg">Off</span>}</dd></div>
                  {user.phone && <div className="flex justify-between gap-3"><dt className="text-muted">Phone</dt><dd className="font-mono text-[12.5px]">{user.phone}</dd></div>}
                </dl>
                <div className="mt-4 flex flex-wrap gap-2">
                  {!mfaOn && <Button size="sm" variant="primary" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setEnrolOpen(true)}>Set up two-step sign-in</Button>}
                  <Button size="sm" variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => setPwOpen(true)}>Change password</Button>
                </div>
                {(access.canSee('/agents/organisation') || access.canSee('/work/channels')) && (
                  <div className="mt-4 pt-4 border-t border-line flex flex-wrap gap-x-4 gap-y-2 text-sm">
                    <SmartLink to="/agents/organisation?tab=sessions" hideWhenBlocked className="link">Sessions</SmartLink>
                    <SmartLink to="/work/channels" hideWhenBlocked className="link">WhatsApp number</SmartLink>
                  </div>
                )}
              </>
            )}
          </Panel>
          <Panel title="Quick keys" tone="sunken">
            <ul className="space-y-2 text-sm">
              <li className="flex items-center justify-between">Command palette <span className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span></li>
              {access.canSee('/') && <li className="flex items-center justify-between">Go to Today <span className="flex gap-1"><Kbd>G</Kbd><Kbd>T</Kbd></span></li>}
              {access.canSee('/approvals') && <li className="flex items-center justify-between">Go to Approvals <span className="flex gap-1"><Kbd>G</Kbd><Kbd>A</Kbd></span></li>}
              <li className="flex items-center justify-between">Go to your preferences <span className="flex gap-1"><Kbd>G</Kbd><Kbd>,</Kbd></span></li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ── Two-step sign-in (TOTP, RFC 6238) ────────────────────────────────── */

function TotpDialog({ open, onClose, orgId, userId }: { open: boolean; onClose: () => void; orgId: string; userId: string }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [code, setCode] = useState('');
  const confirm = useMutation(orgApi.confirmTotp);
  useNow(5000);
  useEffect(() => { if (open) { setSetup(orgApi.startTotp(orgId, userId)); setCode(''); } }, [open, orgId, userId]);
  const grouped = setup?.secret.replace(/(.{4})/g, '$1 ').trim();
  const submit = async () => {
    if (!setup) return;
    try { const r = await confirm.mutate(orgId, userId, setup.secret, code); toast.ok('Two-step sign-in is on', `You will be asked for a code at each sign-in. ${receiptNote(r.seq)}`); onClose(); } catch { /* shown below */ }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Set up two-step sign-in" description="Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and others). Codes change every 30 seconds."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={confirm.pending} disabled={code.length !== 6} onClick={submit}>Turn on</Button></>}>
      {setup && (
        <ol className="space-y-5 text-sm">
          <li>
            <p className="font-medium">1. Add this key to your app</p>
            <p className="mt-1 text-muted">Choose “enter a setup key”, type the key below, and pick time-based codes.</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-[13px] tracking-wider truncate">{grouped}</span>
              <CopyButton text={setup.secret} label="Copy key" />
            </div>
            <CodeBlock className="mt-2" title="Or open this link on the phone" code={setup.uri} wrap />
          </li>
          <li>
            <p className="font-medium">2. Enter the 6-digit code it shows</p>
            <Field htmlFor="totp-code" className="mt-2" error={confirm.error?.message}>
              <Input id="totp-code" mono inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && submit()} placeholder="123456" invalid={!!confirm.error} data-autofocus />
            </Field>
            <p className="mt-2 text-xs text-muted">Demo accounts without a phone to hand: <button type="button" className="link" onClick={() => setCode(orgApi.totpNow(setup.secret))}>fill the current code</button>.</p>
          </li>
        </ol>
      )}
    </Dialog>
  );
}

function PasswordDialog({ open, onClose, orgId, userId }: { open: boolean; onClose: () => void; orgId: string; userId: string }) {
  const user = useUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const change = useMutation(orgApi.changePassword);
  useEffect(() => { if (open) { setCurrent(''); setNext(''); setAgain(''); } }, [open]);
  const checks = passwordChecks(next, { email: user?.email, name: user?.name });
  const ok = passwordOk(next, { email: user?.email, name: user?.name }) && next === again && current.length > 0;
  const submit = async () => {
    try {
      const r = await change.mutate(orgId, userId, current, next);
      toast.ok('Password changed', `Your other sessions were signed out. Demo accounts keep their published password so everyone testing can still sign in. ${receiptNote(r.seq)}`);
      onClose();
    } catch { /* shown below */ }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Change password"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={change.pending} disabled={!ok} onClick={submit}>Change password</Button></>}>
      <div className="space-y-4">
        <Field label="Current password" htmlFor="pw-cur"><PasswordInput id="pw-cur" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-autofocus /></Field>
        <Field label="New password" htmlFor="pw-new">
          <PasswordInput id="pw-new" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-checks" />
          <PasswordChecklist id="pw-checks" checks={checks} />
        </Field>
        <Field label="New password again" htmlFor="pw-again" error={again && again !== next ? 'The two new passwords differ.' : undefined}><PasswordInput id="pw-again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} invalid={!!again && again !== next} /></Field>
        {change.error && <Banner tone="bad">{change.error.message}</Banner>}
      </div>
    </Dialog>
  );
}
