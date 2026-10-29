/**
 * The timestamp authorities Elan1 Govern knows, by the id used in TSA_AUTHORITIES. Hosts are fixed
 * here, never taken from configuration or from a response, so a setting cannot point Elan1 Govern at
 * another host. Kept free of imports so env.ts can validate against it at start-up.
 *
 * Local policy OIDs sit under a UUID arc (2.25.<UUID as an integer>, ITU-T X.667), which needs no
 * registration: 2.25.75094455118098155520562862503281713303 is 387eaa7d-76f4-46c6-b09e-75ef0d7e6097.
 */
const LOCAL_POLICY_ARC = "2.25.75094455118098155520562862503281713303";

export type TsaCatalogEntry =
  | { kind: "local"; name: string; policyOid: string }
  | { kind: "http"; name: string; url: string; caEnv: "TSA_FREETSA_CA_PEM" | "TSA_DIGICERT_CA_PEM" };

export const TSA_CATALOG = {
  "local-a": { kind: "local", name: "Elan1 Govern local TSA A", policyOid: `${LOCAL_POLICY_ARC}.1` },
  "local-b": { kind: "local", name: "Elan1 Govern local TSA B", policyOid: `${LOCAL_POLICY_ARC}.2` },
  freetsa: { kind: "http", name: "FreeTSA", url: "https://freetsa.org/tsr", caEnv: "TSA_FREETSA_CA_PEM" },
  digicert: { kind: "http", name: "DigiCert Timestamp Authority", url: "http://timestamp.digicert.com", caEnv: "TSA_DIGICERT_CA_PEM" },
} as const satisfies Record<string, TsaCatalogEntry>;

export type TsaId = keyof typeof TSA_CATALOG;
export const TSA_IDS = Object.keys(TSA_CATALOG) as TsaId[];
export const isTsaId = (s: string): s is TsaId => Object.hasOwn(TSA_CATALOG, s);
