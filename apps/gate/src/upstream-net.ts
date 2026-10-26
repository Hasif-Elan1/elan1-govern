import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

// Outbound requests to upstream MCP servers. The URL comes from a customer, so Elan1 Govern must not
// become a way to reach its own network (SSRF): only http(s), and unless allowed, no private,
// loopback, link-local or otherwise internal addresses. The check runs inside the socket's DNS
// lookup, so the address that is checked is the address that is connected to (no rebinding gap).

export class UpstreamBlocked extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is refused outright; a BlockList rule for it would match every IPv4 address.
  if (v === 6 && /^::ffff:/i.test(ip)) return true;
  return v === 0 || blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
}

const NOT_PUBLIC = "That address is on a private network. Elan1 Govern only connects to public MCP servers here.";

/** Resolves the host and refuses internal addresses. Used before saving a server, for a clear message. */
export async function checkUpstreamUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamBlocked("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UpstreamBlocked("Use an http or https URL.");
  if (url.username || url.password) throw new UpstreamBlocked("Put credentials in the auth header, not in the URL.");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolveAll(host);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new UpstreamBlocked(NOT_PUBLIC);
  return url;
}

function resolveAll(host: string): Promise<string[]> {
  return new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(new UpstreamBlocked("That host name could not be found.")) : resolve(addrs.map((a) => a.address)))),
  );
}

function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, cb) => {
    dnsLookup(hostname, { all: true }, (err, addrs: LookupAddress[]) => {
      if (err) return cb(err, "", 4);
      if (!addrs.length || (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address)))) return cb(new UpstreamBlocked(NOT_PUBLIC), "", 4);
      if (options.all) return (cb as (e: null, a: LookupAddress[]) => void)(null, addrs);
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}

export interface UpstreamFetchOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * A fetch for the MCP SDK's transport: no redirects followed, a timeout on every request,
 * a cap on response size, and the address check above on every connection.
 */
export function upstreamFetch(opts: UpstreamFetchOptions) {
  const lookup = guardedLookup(opts.allowPrivate);
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UpstreamBlocked("Use an http or https URL.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // Literal IPs skip the DNS lookup, so check them here.
    if (!opts.allowPrivate && isIP(host) && isPrivateAddress(host)) throw new UpstreamBlocked(NOT_PUBLIC);
    if (init.body != null && typeof init.body !== "string") throw new UpstreamBlocked("Unsupported request body.");
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const mod = url.protocol === "https:" ? https : http;

    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(url, { method: init.method ?? "GET", headers, lookup, signal }, (res) => {
        const status = res.statusCode ?? 502;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        let seen = 0;
        const capped = (Readable.toWeb(res) as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, c) {
              seen += chunk.byteLength;
              if (seen > opts.maxBytes) {
                c.error(new UpstreamBlocked("The MCP server sent too much data."));
                res.destroy();
              } else c.enqueue(chunk);
            },
          }),
        );
        const empty = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : capped, { status: status < 200 || status > 599 ? 502 : status, headers: h }));
      });
      req.on("error", reject);
      req.end(init.body ?? undefined);
    });
  };
}
