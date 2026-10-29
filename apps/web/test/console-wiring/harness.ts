import { consoleState } from "@gate/db";
import { NextRequest } from "next/server";
import type { GateService } from "../console-gate";

/*
 * What the wiring tests share (console-wiring.test.ts sets it up: the mocked session, the in-process gate and the
 * built console domain). Each area's cases live in their own module here and take a Harness.
 */

export type Receipt = { seq: number; actor?: string; action?: string; kind?: string; details?: Record<string, unknown> };
// the document as the tests read it
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any> & { receipts: Receipt[] };

export interface Session {
  userId: string;
  /** When the session last confirmed the password: the real routes' "fresh sign-in" rule reads it. */
  lastAuthAt: Date;
}

export interface Harness {
  session: Session;
  gate: GateService;
  /** POST /api/console/rpc as `as` (the session user). */
  rpc(op: string, args: unknown[], as?: string): Promise<{ status: number; body: { result?: unknown; version?: number; error?: string } }>;
  /** GET /api/console/state for `orgId` as `as`. */
  state(orgId: string, as?: string): Promise<{ status: number; doc: Doc }>;
  /** The document as saved in Postgres. */
  saved(orgId: string): Promise<Doc>;
  /** The document as a fresh process reads it. */
  reloaded(orgId: string): Promise<Doc>;
  /** Put an organisation back to the seed (its document rebuilt on its chain at the next operation). */
  reset(orgId: string): Promise<void>;
}

export const lastReceipt = (d: Doc, action: string) => d.receipts.findLast((r) => r.action === action);

export function makeHarness(input: {
  session: Session;
  gate: GateService;
  rpcPost: (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;
  stateGet: (req: NextRequest, seg: { params: Promise<Record<string, string>> }) => Promise<Response>;
  forget: () => Promise<void>;
  stateFor: (orgId: string) => Promise<{ doc: Record<string, unknown> }>;
  resetOrg: (orgId: string) => Promise<unknown>;
}): Harness {
  const seg = { params: Promise.resolve({}) };
  return {
    session: input.session,
    gate: input.gate,
    async rpc(op, args, as) {
      if (as) input.session.userId = as;
      const req = new NextRequest("http://localhost:3000/api/console/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-csrf-token": "csrf-1" },
        body: JSON.stringify({ op, args }),
      });
      const res = await input.rpcPost(req, seg);
      return { status: res.status, body: (await res.json()) as { result?: unknown; version?: number; error?: string } };
    },
    async state(orgId, as) {
      if (as) input.session.userId = as;
      const res = await input.stateGet(new NextRequest(`http://localhost:3000/api/console/state?org=${orgId}`), seg);
      const body = (await res.json()) as { doc?: Doc };
      return { status: res.status, doc: body.doc as Doc };
    },
    async saved(orgId) {
      return JSON.parse((await consoleState.load(orgId))!.json) as Doc;
    },
    async reloaded(orgId) {
      await input.forget();
      return (await input.stateFor(orgId)).doc as unknown as Doc;
    },
    async reset(orgId) {
      await input.forget();
      await input.resetOrg(orgId);
    },
  };
}
