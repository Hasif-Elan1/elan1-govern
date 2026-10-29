import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { BlockedAddressError, isPrivateAddress } from "../webhooks";
import { acceptReply, timestampQuery, TsaError, type TimestampAuthority, type TimestampToken } from "./token";

/**
 * An RFC 3161 authority over HTTP (RFC 3161 §3.4): POST application/timestamp-query, reply
 * application/timestamp-reply. The URL is fixed in the catalog (catalog.ts), never taken from a
 * setting or a reply. Outbound hardening matches the webhook client: the address is checked
 * inside the socket's DNS lookup (no rebinding gap), private and reserved ranges are refused,
 * redirects are never followed, 10 s timeout, 1 MB reply cap. Plain http is acceptable here
 * (DigiCert serves only http): a token is self-authenticating, and the nonce, imprint, signature
 * and a chain to a pinned CA are all checked before it is accepted.
 */

export const TSA_TIMEOUT_MS = 10_000;
export const TSA_MAX_BYTES = 1024 * 1024;

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) => {
    dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
      if (err) return cb(err, []);
      const list = addresses as LookupAddress[];
      if (!list.length) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), []);
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) return cb(new BlockedAddressError(), []);
      if (options.all) return cb(null, list);
      const first = list[0] as LookupAddress;
      return cb(null, first.address, first.family);
    });
  };
}

export interface TsaPostOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/** POST a timestamp query and return the reply body. Rejects with a TsaError (a fixed phrase) on anything unexpected. */
export function postTimestampQuery(url: URL, body: Uint8Array, opts: TsaPostOptions): Promise<Uint8Array> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return Promise.reject(new TsaError("the authority's URL is not http(s)"));
  if (url.username || url.password) return Promise.reject(new TsaError("the authority's URL must not carry credentials"));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) return Promise.reject(new TsaError("the authority's address is private or reserved"));
  const maxBytes = opts.maxBytes ?? TSA_MAX_BYTES;
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply", "content-length": String(body.byteLength) },
        lookup: guardedLookup(opts.allowPrivate) as never,
        signal: AbortSignal.timeout(opts.timeoutMs ?? TSA_TIMEOUT_MS),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        const declared = Number(res.headers["content-length"] ?? 0);
        if (status !== 200 || type !== "application/timestamp-reply" || declared > maxBytes) {
          res.destroy();
          return reject(new TsaError(status >= 300 && status < 400 ? "the authority redirected; redirects are not followed" : status !== 200 ? `the authority answered HTTP ${status}` : declared > maxBytes ? "the authority's reply is too large" : "the authority's reply is not application/timestamp-reply"));
        }
        const chunks: Buffer[] = [];
        let seen = 0;
        res.on("data", (c: Buffer) => {
          seen += c.byteLength;
          if (seen > maxBytes) {
            res.destroy();
            reject(new TsaError("the authority's reply is too large"));
          } else chunks.push(c);
        });
        res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        res.on("error", () => reject(new TsaError("the authority's reply was cut off")));
      },
    );
    req.on("error", (e: Error) => reject(e instanceof BlockedAddressError ? new TsaError("the authority's address is private or reserved") : e.name === "TimeoutError" || e.name === "AbortError" ? new TsaError("the authority did not answer in time") : new TsaError("the authority could not be reached")));
    req.end(body);
  });
}

export class HttpTsa implements TimestampAuthority {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly url: URL,
    /** Pinned certificates (PEM) the authority's signing certificate must chain to. */
    private readonly trusted: string[],
    private readonly opts: TsaPostOptions = { allowPrivate: false },
  ) {}

  async stamp(digestHex: string): Promise<TimestampToken> {
    const query = timestampQuery(digestHex);
    const reply = await postTimestampQuery(this.url, query.der, this.opts);
    return acceptReply(reply, query, { id: this.id, name: this.name, trusted: this.trusted });
  }
}
