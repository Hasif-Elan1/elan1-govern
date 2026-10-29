/**
 * State the Records door keeps beside the organisation's platform state: pack declaration parameters,
 * the Sovereign internal-host allow-list for upstream MCP servers, and AI-system details the shared
 * AiSystem type does not carry (residency, DPDP data principals). It lives on the organisation's database
 * object, so it is saved with it; every change writes a signed admin receipt.
 */
import type { PackId } from '@/types';
import { db } from '@/api';
import { userById } from '@/mock/users';

export interface AiSystemExtra {
  residency: string;
  personalData: boolean;
  principals: string[];
  updatedAt: string;
}

export interface RecordsDoorState {
  /** highest / withdrawn: kept by mock/recordsDecl.ts when a pack declaration version is withdrawn */
  packConfig: Partial<Record<PackId, { values: Record<string, number>; version: number; updatedAt: string; updatedBy: string; highest?: number; withdrawn?: { version: number; at: string; by: string; reason: string; seq?: number; fallbackVersion?: number }[] }>>;
  allowlist: { entries: string[]; updatedAt?: string; updatedBy?: string };
  aiExtra: Record<string, AiSystemExtra>;
  /** tool names this console registered in the tool catalogue for upstream servers */
  registeredTools: string[];
}

type WithExt = { recordsDoor?: RecordsDoorState };

export function doorState(orgId: string): RecordsDoorState {
  const p = db.getDB(orgId).platform as unknown as WithExt;
  if (!p.recordsDoor) p.recordsDoor = { packConfig: {}, allowlist: { entries: [] }, aiExtra: {}, registeredTools: [] };
  p.recordsDoor.packConfig ??= {};
  p.recordsDoor.allowlist ??= { entries: [] };
  p.recordsDoor.aiExtra ??= {};
  p.recordsDoor.registeredTools ??= [];
  return p.recordsDoor;
}

/** Record a change: a signed admin receipt (which also saves the organisation). */
export function recordChange(orgId: string, userId: string, action: string, details: Record<string, string | number | boolean>, agent?: string) {
  return db.logAdmin(orgId, userId, action, details, agent);
}

export const pause = (min = 120, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Owners and admins of the organisation only. */
export function requireManager(orgId: string, userId: string) {
  const u = userById(userId);
  if (!u || !u.orgIds.includes(orgId) || (u.role !== 'owner' && u.role !== 'admin')) throw new Error('Owners and admins can do this; your role cannot.');
}
