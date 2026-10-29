/**
 * Fails the console's typecheck when server.d.ts, the declaration apps/web compiles against, stops describing
 * the real exports of ./entry. Types only: nothing here is bundled.
 */
import type * as real from './entry';
import type * as declared from '../../server';

type Holds<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;

export type DeclarationHolds = [
  Holds<Fits<typeof real.db, declared.DomainDb>>,
  Holds<Fits<typeof real.settle, typeof declared.settle>>,
  Holds<Fits<typeof real.cancelPending, typeof declared.cancelPending>>,
  Holds<Fits<typeof real.holdTimers, typeof declared.holdTimers>>,
  Holds<Fits<typeof real.api, typeof declared.api>>,
  Holds<Fits<typeof real.chainVerifier, typeof declared.chainVerifier>>,
];
