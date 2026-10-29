/**
 * The lifecycle stages of an AI system, in order, with their labels: the vocabulary inventory/ops.ts checks moves
 * against. Kept apart from governance.tsx (chips and icons) so the operations carry no React into the server's
 * domain bundle.
 */
import type { Lifecycle } from '@/types';

export const LIFECYCLE_ORDER: Lifecycle[] = ['proposed', 'in_review', 'approved', 'live', 'retired'];

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = { proposed: 'Proposed', in_review: 'In review', approved: 'Approved', live: 'Live', retired: 'Retired' };
