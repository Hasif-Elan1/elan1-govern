/** Connector lifecycle dialogs: connect a live account, replace the credential, change the address, disconnect, remove, sync diff, internal hosts. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, KeyRound, Plug, ShieldAlert, Trash2 } from 'lucide-react';
import type { Connector } from '@/types';
import { useOrgId, useUser } from '@/store/session';
import { Banner, Button, Dialog, Field, Input, Select, Textarea, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { PACK_CONNECTORS, changeAddress, cloudHostOf, connectLive, disconnect, packOfConnector, removeConnector, replaceCredential, setAllowlist, type SyncDiff } from './ops';
import { upstreamUrlProblem } from './parts';
import { useConnectorEnv, type ConnectorEnv } from './env';

function SecretInput({ id, value, onChange, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} mono type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} invalid={invalid} placeholder={placeholder} className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide value' : 'Show value'} className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center text-muted hover:text-fg">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/* ── Connect a live account ───────────────────────────────── */

function liveSpec(c: Connector) {
  const pack = packOfConnector(c);
  if (pack) {
    const def = PACK_CONNECTORS[pack];
    return { title: `Connect ${def.liveFields.label}`, client: 'API client ID', secret: 'API key', account: def.liveFields.id, regions: def.liveFields.region, consent: `Elan1 Govern calls the provider with this key on behalf of your agents. Tools stay as they are; writes stay switched off until someone switches them on.` };
  }
  if (c.kind === 'gmail') return { title: 'Connect your Google Workspace mailbox', client: 'OAuth client ID (your Google Cloud project)', secret: 'OAuth client secret', account: 'Mailbox to connect', regions: ['Google Workspace'], consent: 'Google asks a mailbox administrator to consent to read, draft and send for this one mailbox (gmail.modify scope). Elan1 Govern holds the refresh token; agents never see it.' };
  if (c.kind === 'zoho_books') return { title: 'Connect your Zoho Books organisation', client: 'OAuth client ID (Zoho API console)', secret: 'OAuth client secret', account: 'Zoho Books organisation ID', regions: ['zoho.in', 'zoho.com', 'zoho.eu'], consent: 'Zoho asks an administrator to consent to the ZohoBooks.fullaccess scope for this organisation. Elan1 Govern holds the refresh token; agents never see it.' };
  return { title: `Connect ${c.name} live`, client: 'Client ID', secret: 'Secret', account: 'Account', regions: ['Default'], consent: 'Elan1 Govern holds the credential; agents never see it.' };
}

export function LiveDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connector }) {
  const orgId = useOrgId();
  const user = useUser();
  const spec = liveSpec(c);
  const env = useConnectorEnv();
  // Sovereign deny-all egress: Google Workspace and Zoho's cloud are outside the network (ops.ts connectLive refuses and records it)
  const cloud = env.data?.sovereign ? cloudHostOf(c) : undefined;
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [account, setAccount] = useState('');
  const [region, setRegion] = useState(spec.regions[0]);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<{ toolsListed: number; seq: number }>();
  useEffect(() => { if (open) { setClientId(''); setSecret(''); setAccount(''); setRegion(liveSpec(c).regions[0]); setConsented(false); setErr(undefined); setDone(undefined); } }, [open, c]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await connectLive(orgId, c.id, { clientId, secret, region, account }, user.id);
      setDone({ toolsListed: r.toolsListed, seq: r.seq });
      toast.ok(`${c.name} is live`, `Test call listed ${plural(r.toolsListed, 'tool')}. The change is a receipt on the chain.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} size="lg" title={done ? 'Live account connected' : spec.title}
      description={done ? undefined : 'Use your own OAuth app or API client. The secret is encrypted and shown masked afterwards; agents never see it.'}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          {!consented
            ? <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} disabled={clientId.trim().length < 6 || secret.trim().length < 8 || !account.trim()} onClick={() => setConsented(true)}>Continue to consent</Button>
            : <Button variant="primary" icon={<Plug className="h-4 w-4" />} loading={busy} onClick={go}>Run a test call and switch to live</Button>}
        </>
      )}>
      {done ? (
        <Banner tone="ok" title={`${c.name} now runs against your live account`}>
          The test call listed {plural(done.toolsListed, 'tool')}. Mode changed from demo to live — receipt <ReceiptLink seq={done.seq} />. Tools that were off stay off.
        </Banner>
      ) : !consented ? (
        <div className="space-y-4">
          {err && <Banner tone="bad" title="Could not connect">{err}</Banner>}
          {cloud && (
            <Banner tone="held" title="Not reachable under deny-all egress">
              {c.kind === 'gmail' ? 'Gmail runs in Google’s cloud' : 'Zoho Books runs in Zoho’s cloud'}, outside your network. Your Sovereign deployment sends nothing to the internet, so the test call is refused and the attempt is recorded as an egress.blocked receipt. Connect a mail or accounting system inside your network as an MCP server instead.
            </Banner>
          )}
          <Field label={spec.client} required htmlFor="live-client"><Input id="live-client" mono value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" data-autofocus /></Field>
          <Field label={spec.secret} required htmlFor="live-secret" hint="At least 8 characters. Shown masked afterwards."><SecretInput id="live-secret" value={secret} onChange={setSecret} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={spec.account} required htmlFor="live-account"><Input id="live-account" value={account} onChange={(e) => setAccount(e.target.value)} /></Field>
            <Field label="Region or endpoint" htmlFor="live-region">
              <Select id="live-region" value={region} onChange={(e) => setRegion(e.target.value)}>{spec.regions.map((r) => <option key={r}>{r}</option>)}</Select>
            </Field>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {err && <Banner tone="bad" title="Could not connect">{err}</Banner>}
          <Banner tone="info" title="Consent step">{spec.consent}</Banner>
          <p className="text-sm text-muted">Next, Elan1 Govern makes one read-only test call with these details and lists the tools. If it answers, the connector switches from demo to live and a <span className="font-mono">connector.mode_changed</span> receipt is written.</p>
          <Button size="sm" variant="ghost" onClick={() => setConsented(false)}>Back to the details</Button>
        </div>
      )}
    </Dialog>
  );
}

/* ── Replace credential ───────────────────────────────────── */

export function CredentialDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connector }) {
  const orgId = useOrgId();
  const user = useUser();
  const [header, setHeader] = useState('Authorization');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setHeader(c.authHeader?.startsWith('X-Api-Key') ? 'X-Api-Key' : 'Authorization'); setSecret(''); setErr(undefined); } }, [open, c]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await replaceCredential(orgId, c.id, header, secret, user.id);
      toast.ok('Credential replaced', 'The old value is no longer sent. The change is recorded.');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Replace the credential" description={<>For <span className="font-mono">{c.name}</span>. The new value is used from the next call; the old one is discarded.</>}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={busy} disabled={secret.trim().length < 8} onClick={go}>Replace credential</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Could not replace it">{err}</Banner>}
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Header" htmlFor="cred-h"><Select id="cred-h" value={header} onChange={(e) => setHeader(e.target.value)}><option>Authorization</option><option>X-Api-Key</option></Select></Field>
          <Field label="New value" required htmlFor="cred-v" hint="Shown masked afterwards."><SecretInput id="cred-v" value={secret} onChange={setSecret} placeholder={header === 'Authorization' ? 'Bearer …' : '…'} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

/* ── Change address ───────────────────────────────────────── */

export function AddressDialog({ open, onClose, c, env }: { open: boolean; onClose: () => void; c: Connector; env?: ConnectorEnv }) {
  const orgId = useOrgId();
  const user = useUser();
  const [url, setUrl] = useState(c.url ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setUrl(c.url ?? ''); setErr(undefined); } }, [open, c]);
  const opts = { sovereign: !!env?.sovereign, allow: env?.allow ?? [], domain: env?.domain };
  const urlProblem = upstreamUrlProblem(url, opts);
  const urlErr = urlProblem?.message;
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await changeAddress(orgId, c.id, url, user.id, opts);
      toast.ok('Address changed', 'Sync the server to list its tools from the new address.');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Change the server address"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={(!!urlErr && !urlProblem?.egress) || url.trim() === c.url} onClick={go}>Save address</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Could not change it">{err}</Banner>}
        <Field label="Server address" htmlFor="addr" error={url.length > 8 ? urlErr : undefined} hint={env?.sovereign ? 'https only. Egress is denied: only hosts inside your network (your own domain, or private hosts on your allow-list). A public address is refused and recorded.' : 'https only. Private network addresses are refused on the hosted service.'}>
          <Input id="addr" mono value={url} onChange={(e) => setUrl(e.target.value)} invalid={url.length > 8 && !!urlErr} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ── Disconnect ───────────────────────────────────────────── */

export function DisconnectDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connector }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setReason(''); setErr(undefined); } }, [open]);
  const on = c.tools.filter((t) => t.enabled).length;
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await disconnect(orgId, c.id, reason.trim(), user.id);
      toast.info(`${c.name} disconnected`, `${plural(on, 'tool')} switched off. Calls to them are refused by default.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} tone="danger" title={`Disconnect ${c.name}?`} description="Every tool on it is switched off at once, so every call to them is refused by default. You can reconnect later; tools stay off until someone switches them on."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 4} onClick={go}>Disconnect and switch off {plural(on, 'tool')}</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Could not disconnect">{err}</Banner>}
        <Field label="Reason" required htmlFor="disc-r" hint="Recorded on the receipt."><Textarea id="disc-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

/* ── Remove ───────────────────────────────────────────────── */

export function RemoveDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: Connector }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setTyped(''); setErr(undefined); } }, [open]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await removeConnector(orgId, c.id, user.id);
      toast.info(`${c.name} removed`, 'Its receipts stay on the chain. Agents that named its tools are refused by default.');
      onClose();
      nav('/connectors');
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} tone="danger" title={`Remove ${c.name}?`} description="Its tools leave the catalogue and its credential is discarded. Receipts it produced stay on the chain and keep verifying."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={busy} disabled={typed.trim() !== c.name} onClick={go}>Remove connector</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Could not remove it">{err}</Banner>}
        <Field label={<>Type <span className="font-mono">{c.name}</span> to confirm</>} htmlFor="rm-c"><Input id="rm-c" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
      </div>
    </Dialog>
  );
}

/* ── Sync diff ────────────────────────────────────────────── */

export function SyncDiffDialog({ diff, onClose }: { diff?: SyncDiff; onClose: () => void }) {
  const any = !!diff && (diff.changed.length + diff.added.length + diff.removed.length) > 0;
  return (
    <Dialog open={!!diff} onClose={onClose} size="lg" title={any ? 'The server changed its tools' : 'Nothing changed'}
      description={diff ? <>{diff.connector} listed {plural(diff.checked, 'tool')} · receipt <ReceiptLink seq={diff.seq} /></> : undefined}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {diff && !any && <p className="text-sm text-muted">Every tool name and description matches what was approved before. Nothing was switched off.</p>}
      {diff && any && (
        <div className="space-y-4">
          {diff.switchedOff.length > 0 && (
            <Banner tone="held" title={`${plural(diff.switchedOff.length, 'tool')} switched off for review`}>
              A changed description changes what agents are told the tool does. Check its risk tags, then switch it back on.
            </Banner>
          )}
          {diff.changed.length > 0 && (
            <section>
              <h3 className="label mb-2">Description changed</h3>
              <ul className="border border-line divide-y divide-line">
                {diff.changed.map((ch) => (
                  <li key={ch.tool} className="px-4 py-3 text-sm space-y-1">
                    <p className="font-mono text-[12.5px] font-medium">{ch.tool}</p>
                    <p className="text-bad-fg"><span className="label mr-2">Before</span><del>{ch.before}</del></p>
                    <p className="text-ok-fg"><span className="label mr-2">Now</span>{ch.after}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {diff.added.length > 0 && (
            <section>
              <h3 className="label mb-2">New tools — switched off, untagged</h3>
              <ul className="flex flex-wrap gap-2">{diff.added.map((t) => <li key={t} className="font-mono text-[12.5px] border border-line px-2 py-1">{t}</li>)}</ul>
            </section>
          )}
          {diff.removed.length > 0 && (
            <section>
              <h3 className="label mb-2">No longer listed — removed</h3>
              <ul className="flex flex-wrap gap-2">{diff.removed.map((t) => <li key={t} className="font-mono text-[12.5px] border border-line px-2 py-1 line-through">{t}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* ── Sovereign: internal hosts ────────────────────────────── */

export function AllowlistDialog({ open, onClose, env }: { open: boolean; onClose: () => void; env?: ConnectorEnv }) {
  const orgId = useOrgId();
  const user = useUser();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (open) { setText((env?.allow ?? []).join('\n')); setErr(undefined); } }, [open, env]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await setAllowlist(orgId, text.split(/[\n,]+/), user.id);
      toast.ok('Internal hosts saved', `${plural(r.entries.length, 'entry', 'entries')}. Upstream servers on these hosts can now be added.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Internal hosts for MCP servers" description="On your own infrastructure, upstream MCP servers live on private networks. List the hosts or ranges Elan1 Govern may call. Loopback and link-local stay refused."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<ShieldAlert className="h-4 w-4" />} loading={busy} onClick={go}>Save allow-list</Button></>}>
      <div className="space-y-3">
        {err && <Banner tone="bad" title="Could not save">{err}</Banner>}
        <Field label="One per line" htmlFor="allow" hint="A host (mcp.core.bank.internal), a wildcard (*.svc.cluster.local), an IPv4 address or a CIDR range (10.20.0.0/16).">
          <Textarea id="allow" rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[13px]" />
        </Field>
        {env?.allowMeta.updatedAt && <p className="text-xs text-muted">Last changed by {userName(env.allowMeta.updatedBy)} <When iso={env.allowMeta.updatedAt} />.</p>}
      </div>
    </Dialog>
  );
}
