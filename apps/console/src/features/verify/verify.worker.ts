/**
 * Runs the six-code verifier off the main thread so a full bundle (around 1,000 Ed25519 checks) never
 * freezes the page. The same code as lib/verify6 — nothing is sent anywhere.
 */
import { verifyBundle, type VerifyBundleOptions } from '@/lib/verify6';

const ctx = self as unknown as Worker;

ctx.onmessage = (e: MessageEvent<{ id: number; bundle: unknown; opts: VerifyBundleOptions }>) => {
  const { id, bundle, opts } = e.data;
  try {
    ctx.postMessage({ id, result: verifyBundle(bundle, opts) });
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error).message || 'The verifier stopped unexpectedly.' });
  }
};
