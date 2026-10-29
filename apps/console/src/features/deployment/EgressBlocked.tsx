import { SmartLink } from '@/shell/access';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { StatusChip } from '@/components/ui';

/**
 * Shown in place of a feature that would reach outside a Sovereign deployment's network (Slack, WhatsApp, an
 * external webhook): what is blocked, why, and what to use instead. The control itself is not offered.
 */
export function EgressBlocked({ service, host, instead, className, compact }: { service: string; host: string; instead?: string; className?: string; compact?: boolean }) {
  return (
    <div className={cn('text-sm', className)}>
      <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Not available · egress denied</StatusChip>
      <p className={cn('mt-2 text-muted leading-relaxed', compact && 'text-xs')}>
        {service} needs <span className="font-mono text-[12px] text-fg">{host}</span>, which is outside your network. This deployment denies all egress, so it is switched off rather than left to fail.{instead ? ` ${instead}` : ''}
      </p>
      <SmartLink to="/agents/deployment?tab=egress" hideWhenBlocked className="mt-1 inline-block text-xs link">Egress log and internal allow-list</SmartLink>
    </div>
  );
}

/** The chip alone, for a table cell or a header. */
export function EgressDeniedChip() {
  return <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Egress denied</StatusChip>;
}
