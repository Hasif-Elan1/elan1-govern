import { PackageOpen } from 'lucide-react';
import { SmartLink } from '@/shell/access';
import { plural } from '@/lib/format';
import { ExportPackDialog } from '@/features/evidence/ExportPackDialog';

/**
 * Export verifiable evidence for the range shown in Activity. It is the same export as Assurance › Exports: at L1
 * the auditor pack (ZIP or JSON, free); from L2 the 8-member evidence bundle, with the size split, the residency,
 * consent and declarations checks, "Verify it yourself first" and the ₹2,500 charge shown before it is generated.
 * The export is itself recorded on the chain.
 */
export function ExportRangeDialog({ open, onClose, from, to, matching }: { open: boolean; onClose: () => void; from?: number; to?: number; matching: number }) {
  return (
    <ExportPackDialog
      open={open}
      onClose={onClose}
      initialFrom={from}
      initialTo={to}
      title="Export the range shown in Activity"
      note={
        <p>
          {plural(matching, 'receipt')} {matching === 1 ? 'matches' : 'match'} your filters. An export is a contiguous piece of the chain, so it holds every receipt in the range — the ones your filters hide too. That is what lets the verifier check the links.{' '}
          <SmartLink to={`/assurance/exports${from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : ''}`} hideWhenBlocked onClick={onClose} className="inline-flex items-center gap-1 font-medium text-fg hover:underline underline-offset-2"><PackageOpen className="h-3.5 w-3.5" aria-hidden />Past exports</SmartLink>
        </p>
      }
    />
  );
}
