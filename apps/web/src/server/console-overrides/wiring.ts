import "server-only";

/*
 * wiring: the console's billing, sovereign deployment, identity, webhook and chat-channel screens on the real
 * backends. Each area registers its overrides from its own module; what they share is in ./wiring/common.ts, and
 * the gate's side is apps/gate/src/console-wiring.ts.
 */
import "./wiring/billing";
import "./wiring/identity";
import "./wiring/sovereign";
import "./wiring/webhooks";
