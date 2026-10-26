import "server-only";
import { signRequest } from "@gate/core";
import { env } from "./env";

/** A signed call to the gate service's internal API. The web app never holds signing keys. */
export async function gate<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${env().GATE_INTERNAL_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-gate-signature": signRequest(env().INTERNAL_API_SECRET, method, path, payload),
    },
    ...(payload ? { body: payload } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

export async function gateBytes(path: string, body: unknown): Promise<{ status: number; bytes: ArrayBuffer; error?: string }> {
  const payload = JSON.stringify(body);
  const res = await fetch(`${env().GATE_INTERNAL_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-signature": signRequest(env().INTERNAL_API_SECRET, "POST", path, payload) },
    body: payload,
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { status: res.status, bytes: new ArrayBuffer(0), error: j.error ?? "Gate could not build the file." };
  }
  return { status: res.status, bytes: await res.arrayBuffer() };
}
