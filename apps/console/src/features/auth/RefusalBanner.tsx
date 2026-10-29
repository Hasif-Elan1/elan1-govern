import { Fingerprint } from 'lucide-react';
import { Banner, Button } from '@/components/ui';
import { refusalText, type Refusal } from './signInPolicy';

/** Why the organisation's policy refused a password sign-in, with the way forward (SSO, or ask an owner). */
export function RefusalBanner({ refusal, onSso, id = 'signin-error' }: { refusal: Refusal; onSso?: () => void; id?: string }) {
  if (refusal.kind === 'sso_only' || refusal.kind === 'saml_required') {
    return (
      <div id={id} role="alert">
        <Banner tone="held" title={refusal.kind === 'saml_required' ? 'SAML sign-in required' : 'Single sign-on required'}
          actions={onSso && <Button size="sm" variant="primary" icon={<Fingerprint className="h-3.5 w-3.5" />} onClick={onSso}>Continue with single sign-on</Button>}>
          {refusalText(refusal)}
        </Banner>
      </div>
    );
  }
  return (
    <div id={id} role="alert">
      <Banner tone="bad" title={refusal.kind === 'suspended' ? 'Your access is suspended' : 'No access to this organisation'}>
        {refusalText(refusal)}
      </Banner>
    </div>
  );
}
