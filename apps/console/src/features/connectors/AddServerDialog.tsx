import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, ServerCog, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Connector } from '@/types';
import { plural } from '@/lib/format';
import { Banner, Button, Dialog, Field, Input, Select, Disc, toast } from '@/components/ui';
import { TagList } from '@/components/domain';
import { serverSlug, upstreamUrlProblem } from './parts';
import { addUpstreamServer, deriveTools } from './ops';
import type { ConnectorEnv } from './env';

const RESERVED = ['gate', 'gmail', 'zoho', 'zoho_books', 'elan1', 'tally', 'irp', 'gst', 'collect'];

export function AddServerDialog({ open, onClose, existing, env, onOpenAllowlist }: { open: boolean; onClose: () => void; existing: Connector[]; env?: ConnectorEnv; onOpenAllowlist?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = useOrgLevel() !== 'l1';
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<'form' | 'discovering' | 'done'>('form');
  const [result, setResult] = useState<Connector>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setName(''); setUrl(''); setHeaderName('Authorization'); setSecret(''); setShow(false); setTried(false); setPhase('form'); setResult(undefined); setErr(undefined);
  }, [open]);

  const opts = { sovereign: !!env?.sovereign, allow: env?.allow ?? [], domain: env?.domain };
  const slug = serverSlug(name);
  const nameErr = name.trim().length < 3 ? 'Give the server a name of at least 3 characters.'
    : RESERVED.includes(slug) ? `“${slug}” is reserved for built-in and pack tools.`
    : existing.some((c) => serverSlug(c.name) === slug) ? 'Another server already uses this name.' : undefined;
  const urlProblem = upstreamUrlProblem(url, opts);
  const urlErr = urlProblem?.message;
  const secretErr = secret.trim().length < 8 ? 'Paste the credential the server expects (at least 8 characters).' : undefined;
  const preview = useMemo(() => (!nameErr && !urlErr ? deriveTools(name, url) : []), [name, url, nameErr, urlErr]);

  const submit = async () => {
    setTried(true);
    // a public address at Sovereign still goes to the guard, which refuses it and records egress.blocked
    if (nameErr || (urlErr && !urlProblem?.egress) || secretErr || !user) return;
    setPhase('discovering');
    setErr(undefined);
    try {
      const c = await addUpstreamServer(orgId, { name: name.trim(), url: url.trim(), headerName, secret }, user.id, opts);
      setResult(c);
      setPhase('done');
      toast.ok(`${c.name} connected`, `${plural(c.tools.length, 'tool')} found. Every tool starts switched off.`);
    } catch (e) {
      setPhase('form');
      setErr((e as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={phase === 'discovering' ? () => undefined : onClose}
      size="lg"
      title={phase === 'done' ? 'Tools discovered' : 'Add an MCP server'}
      description={phase === 'done'
        ? 'Every tool starts switched off. Check the suggested risk tags, then switch on only what your agents need.'
        : 'Put an MCP server you run behind Elan1 Govern. Agents never see its credential; each call is checked against the agent\'s rulebook first.'}
      footer={phase === 'done' && result ? (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => { onClose(); nav(`/connectors/${result.id}`); }}>Review tools and switch on</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={phase === 'discovering'}>Cancel</Button>
          <Button variant="primary" icon={<ServerCog className="h-4 w-4" />} loading={phase === 'discovering'} onClick={submit}>Connect and list tools</Button>
        </>
      )}
    >
      {phase === 'discovering' && (
        <div className="flex flex-col items-center py-10 text-center" role="status" aria-live="polite">
          <Disc kind="orbit" size={44} title="Connecting" />
          <p className="mt-4 font-medium">Connecting to {url.trim()}</p>
          <p className="mt-1 text-sm text-muted">Checking the address, sending the header and listing tools…</p>
        </div>
      )}

      {phase === 'form' && (
        <div className="space-y-5">
          {err && <Banner tone="bad" title="Could not add the server">{err}</Banner>}
          <Field label="Name" required htmlFor="up-name" error={tried ? nameErr : undefined} hint={slug ? <>Its tools are named <span className="font-mono">{slug}.&lt;tool&gt;</span> on every receipt.</> : 'Used as the tool prefix on every receipt.'}>
            <Input id="up-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: CRM MCP" invalid={tried && !!nameErr} data-autofocus />
          </Field>
          <Field label="Server address" required htmlFor="up-url" error={(tried || url.length > 8) ? urlErr : undefined} hint="https only. Do not put credentials in the address.">
            <Input id="up-url" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={env?.sovereign ? 'https://crm-mcp.svc.cluster.local/mcp' : 'https://crm-mcp.example.com/mcp'} invalid={(tried || url.length > 8) && !!urlErr} inputMode="url" autoComplete="off" spellCheck={false} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <Field label="Header" htmlFor="up-hname">
              <Select id="up-hname" value={headerName} onChange={(e) => setHeaderName(e.target.value)}>
                <option>Authorization</option>
                <option>X-Api-Key</option>
              </Select>
            </Field>
            <Field label="Header value" required htmlFor="up-secret" error={tried ? secretErr : undefined} hint={env?.sovereign ? `Stored in ${env.secrets ?? 'your OpenBao'} on your cluster and shown masked afterwards.` : 'Encrypted at rest and shown masked afterwards. Elan1 Govern sends it; agents never see it.'}>
              <div className="relative">
                <Input id="up-secret" mono type={show ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={headerName === 'Authorization' ? 'Bearer …' : '…'} autoComplete="new-password" spellCheck={false} invalid={tried && !!secretErr} className="pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide value' : 'Show value'} className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center text-muted hover:text-fg">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          </div>
          {preview.length > 0 && (
            <p className="text-xs text-muted">From its name and address this looks like a server with tools such as <span className="font-mono text-fg">{preview.slice(0, 3).map((t) => t.name).join(', ')}</span>. The real list comes from the server when you connect.</p>
          )}
          {env?.sovereign ? (
            <Banner tone="neutral" title="Network safety — your own infrastructure"
              actions={onOpenAllowlist ? <Button size="sm" variant="secondary" onClick={onOpenAllowlist}>Edit internal hosts</Button> : undefined}>
              Egress is denied: Elan1 Govern reaches only MCP servers inside your network. A public address is refused, and the attempt is recorded as an egress.blocked receipt. Your own domain{env.domain ? <> (<span className="font-mono">{env.domain}</span>)</> : ''} is inside the network; private addresses (10.x, 172.16–31.x, 192.168.x, *.internal, *.local, *.lan) are allowed only for hosts on your internal allow-list ({plural(opts.allow.length, 'entry', 'entries')}). Loopback and link-local are always refused.
            </Banner>
          ) : (
            <Banner tone="neutral" title="Network safety">
              Private addresses are refused on the hosted service: loopback, 10.x, 172.16–31.x, 192.168.x, link-local and similar ranges. On a Sovereign deployment an admin can allow internal hosts. Upstream errors are shown to agents in general terms only.
            </Banner>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" />Upstream authentication is a single header.</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div className="space-y-4">
          <Banner tone="ok" title={`${result.name} is connected`}>{plural(result.tools.length, 'tool')} found. None can be called until you switch it on, and every call still needs a rule that allows it.</Banner>
          <ul className="border border-line divide-y divide-line">
            {result.tools.map((t) => (
              <li key={t.name} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="font-mono text-[12.5px]">{t.name}</p>
                  <p className="text-xs text-muted">{t.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[10px] uppercase tracking-label text-info-fg">Suggested tags</span>
                  <TagList tags={t.suggestedTags ?? []} />
                  <span className="text-xs text-muted inline-flex items-center gap-1"><ShieldAlert className="h-3 w-3" />Off</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted inline-flex items-start gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />The connection is recorded as {signedLevel ? 'a signed receipt' : 'a receipt sealed in the hash chain'}, and its tools are in the catalogue so rules, Try an action and Activity can name them. Tool descriptions from the server are passed to agents as they are.</p>
        </div>
      )}
    </Dialog>
  );
}
