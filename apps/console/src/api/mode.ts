/**
 * Where the console's data comes from: `live` (the real backend, through the same origin) or `mock` (the in-browser
 * demonstration, as approved). Chosen at build time with VITE_DATA=mock|live (vite.config.ts; live by default).
 *
 * The domain bundle the server runs (scripts/build-server.mjs) never defines it, so there the domain behaves exactly
 * as the mock does: it IS the mock, run on the server.
 */
declare const __GOVERN_DATA__: string | undefined;

export const LIVE: boolean = typeof __GOVERN_DATA__ !== 'undefined' && __GOVERN_DATA__ === 'live';
