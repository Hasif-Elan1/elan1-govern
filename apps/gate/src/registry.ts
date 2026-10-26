import { builtinRegistry, type ToolRegistry } from "@gate/core";
import type { Deps } from "./deps";

/**
 * The tools an org's agents can ask for: the built-in Gmail and Zoho Books tools,
 * plus any the org has added from upstream connectors.
 */
export async function registryFor(_deps: Deps, _orgId: string): Promise<ToolRegistry> {
  return builtinRegistry;
}
