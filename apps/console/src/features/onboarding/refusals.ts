/**
 * Who we do not onboard, and the one sentence we say to each.
 *
 * Eight applicant categories are refused at set-up and at the sandbox application. Each has a plain sentence that
 * says what we will not do and why, and — where there is one — what we can do instead. The sentence is shown to
 * the applicant as written; it is never softened into "not a fit right now".
 */

export type ApplicantCategory =
  | 'eligible'
  | 'individual'
  | 'model_decides'
  | 'enforce_without_route'
  | 'residency_elsewhere'
  | 'hide_refusals'
  | 'sanctioned'
  | 'unsupported_regime'
  | 'covert_profiling';

export interface ApplicantRefusal {
  id: Exclude<ApplicantCategory, 'eligible'>;
  /** how the applicant describes themselves (the option they pick) */
  label: string;
  /** the refusal sentence */
  sentence: string;
  /** what we can do instead, when there is something */
  instead?: string;
}

export const ELIGIBLE_LABEL = 'An organisation whose agents act on its own systems, with people who answer for them';

export const APPLICANT_REFUSALS: ApplicantRefusal[] = [
  {
    id: 'individual', label: 'A person on my own, not an organisation',
    sentence: 'We do not open accounts for individuals: every receipt is made in an organisation’s name and under its key, so there has to be an organisation that answers for its agents.',
    instead: 'Read the docs and run the TryIt panels without an account; apply again with your organisation’s work email.',
  },
  {
    id: 'model_decides', label: 'We want a model to approve or refuse what our agents do',
    sentence: 'We do not take on work where a model makes the decision: a model may propose an action, but only a rulebook a person wrote and published, or a person, may allow it.',
    instead: 'Let the model draft and propose; route what it proposes to a named approver.',
  },
  {
    id: 'enforce_without_route', label: 'We want calls stopped without sending them through Elan1 Govern',
    sentence: 'We cannot say a call was stopped unless it went through Elan1 Govern holding the credentials: check and record evaluates and records every attempt, including the refused ones, but it does not stop an agent that skips the check.',
    instead: 'Use a governed run over MCP for the tools you need stopped, or use check and record and describe it as advisory.',
  },
  {
    id: 'residency_elsewhere', label: 'Our records must stay in a region other than India',
    sentence: 'We do not host organisations outside ap-south-1 Mumbai yet, and we will not move your records out of the region you need them in.',
    instead: 'Sovereign runs Elan1 Govern inside your own data centre, wherever that is.',
  },
  {
    id: 'hide_refusals', label: 'We only want to keep the actions that were allowed',
    sentence: 'We do not drop refusals: every attempt, including every refusal, is a receipt on the chain, because a record that hides its refusals is not evidence.',
  },
  {
    id: 'sanctioned', label: 'We are in, owned by, or acting for a sanctioned country or party',
    sentence: 'We cannot onboard an organisation that is in, owned by, or acting for a country or party under sanctions that apply to us under Indian law or UN, EU, UK or US sanctions.',
  },
  {
    id: 'unsupported_regime', label: 'We need a regulatory claim for agriculture, legal, energy, the public sector, education or retail',
    sentence: 'We do not make a regulatory claim for that sector: there is no regulatory pack for it, and we will not imply one.',
    instead: 'You can still govern and record your agents; the records make no claim under that sector’s rules.',
  },
  {
    id: 'covert_profiling', label: 'Our agents watch, score or profile people without their knowledge',
    sentence: 'We do not govern agents built to watch, score or profile people without their knowledge, and we will not put our receipts behind that work.',
  },
];

export const refusalFor = (c?: ApplicantCategory) => APPLICANT_REFUSALS.find((r) => r.id === c);

/** Personal mailbox domains: an applicant on one of these is treated as an individual (category 1). */
const PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'aol.com'];

export function isPersonalEmail(email: string) {
  const dom = email.trim().toLowerCase().split('@')[1] ?? '';
  return PERSONAL_DOMAINS.includes(dom);
}
