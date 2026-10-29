import { FlaskConical } from 'lucide-react';
import type { Receipt } from '@/types';
import { StatusChip } from '@/components/ui';

/**
 * Marks a receipt written from a sandbox agent key (sk_sbx_). The environment is part of the signed receipt body,
 * so it cannot be removed afterwards without the receipt failing verification.
 */
export function EnvironmentChip({ r, withNote }: { r: Pick<Receipt, 'environment'>; withNote?: boolean }) {
  if (r.environment !== 'sandbox') return withNote ? <span className="text-sm">production</span> : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" title="Made with a sandbox agent key (sk_sbx_). The environment is inside the signed receipt.">
      <StatusChip tone="held" size="sm" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>Sandbox · sk_sbx_</StatusChip>
      {withNote && <span className="text-xs text-muted">Made with a sandbox key while building or testing. Part of the signed receipt.</span>}
    </span>
  );
}
