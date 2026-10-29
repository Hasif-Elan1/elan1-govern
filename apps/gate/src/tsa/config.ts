import type { Deps } from "../deps";
import { isTsaId, TSA_CATALOG, type TsaCatalogEntry } from "./catalog";
import { HttpTsa } from "./http";
import { LocalTsa } from "./local";
import type { TimestampAuthority } from "./token";

const built = new WeakMap<Deps, TimestampAuthority[]>();

/**
 * The authorities named in TSA_AUTHORITIES (validated at start-up in env.ts), built once per
 * service. Local ones keep their keys in TsaKey; HTTP ones use the fixed catalog URL and the
 * pinned CA from their TSA_*_CA_PEM setting.
 */
export function configuredAuthorities(deps: Deps): TimestampAuthority[] {
  let list = built.get(deps);
  if (!list) {
    list = deps.env.TSA_AUTHORITIES.map((id) => {
      const entry = TSA_CATALOG[id];
      if (entry.kind === "local") return new LocalTsa({ db: deps.db, keys: deps.keys }, id, entry.name, entry.policyOid);
      return new HttpTsa(id, entry.name, new URL(entry.url), [deps.env[entry.caEnv] ?? ""]);
    });
    built.set(deps, list);
  }
  return list;
}

/**
 * The pinned certificates (PEM) that tokens from `tsaId` must chain to, for verifying stored
 * tokens. Works for an authority that is no longer configured: a local one's certificate stays in
 * TsaKey, so its old tokens keep verifying after a switch to hosted authorities.
 */
export async function trustedCertsFor(deps: Deps, tsaId: string): Promise<string[]> {
  if (!isTsaId(tsaId)) return [];
  const entry: TsaCatalogEntry = TSA_CATALOG[tsaId];
  if (entry.kind === "local") {
    const row = await deps.db.tsaKey.findUnique({ where: { id: tsaId }, select: { certPem: true } });
    return row ? [row.certPem] : [];
  }
  const pem = deps.env[entry.caEnv];
  return pem ? [pem] : [];
}
