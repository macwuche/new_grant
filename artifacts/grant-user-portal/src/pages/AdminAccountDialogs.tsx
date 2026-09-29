import { useState } from 'react';
import type { Tier } from '@workspace/domain/model';
import { MIN_REASON_LENGTH } from '@workspace/domain/accounts';
import { AdminModal } from './AdminModal';
import { reasonAct, useAccountAction, type Outcome, type ReasonAction } from './AdminApplicantPanel';
import { RoleNotice } from './AdminStaff';

// Account actions that need a reason sent to the applicant: a tier change, a
// lock, rejecting an identity check, or asking them to verify again. Used by the
// applicant directory and the applicant profile page.

export const TIER_LABELS: Record<Tier, string> = { 1: 'Tier 1 · Basic', 2: 'Tier 2 · Verified', 3: 'Tier 3 · Enterprise' };

const COPY: Record<ReasonAction, { title: string; label: string; button: string; danger: boolean }> = {
  tier: { title: 'Change account tier', label: 'Reason for the change (sent to the applicant)', button: 'Confirm tier change', danger: false },
  lock: { title: 'Lock account', label: 'Why is the account being locked? (sent to the applicant)', button: 'Lock account', danger: true },
  'kyc-reject': { title: 'Reject identity check', label: 'Why is it rejected? (sent to the applicant)', button: 'Reject identity check', danger: true },
  reverify: { title: 'Ask to verify again', label: 'Why must they verify again? (sent to the applicant)', button: 'Ask to verify again', danger: true },
};
const PERMISSION = { tier: 'accounts.tier', lock: 'accounts.manage', 'kyc-reject': 'kyc.review', reverify: 'kyc.review' } as const;

export function ReasonDialog({ applicantId, name, action, tier, onClose, onDone }: {
  applicantId: string; name: string; action: ReasonAction; tier?: Tier | null; onClose: () => void; onDone: (outcome: Outcome) => void;
}) {
  const { busy, perform } = useAccountAction();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[action];
  const submit = async () => {
    if (reason.trim().length < MIN_REASON_LENGTH) { setError(`Write at least ${MIN_REASON_LENGTH} characters.`); return; }
    const act = reasonAct(applicantId, action, reason, tier);
    if (!act) return;
    const outcome = await perform(act, applicantId);
    if (!outcome.ok) { setError(outcome.fieldErrors?.reason ?? outcome.error); return; }
    onDone(outcome);
  };
  return <AdminModal title={copy.title} subtitle={action === 'tier' && tier ? `${name} → ${TIER_LABELS[tier]}` : name} onClose={onClose} testId="dialog-admin-account-reason"
    footer={<><button type="button" className="aup-btn" onClick={onClose}>Cancel</button><button type="button" className={`aup-btn ${copy.danger ? 'danger' : 'primary'}`} disabled={busy} onClick={() => void submit()} data-testid="button-admin-reason-confirm">{busy ? 'Saving…' : copy.button}</button></>}>
    <label className="aup-field"><span>{copy.label}</span>
      <textarea rows={4} value={reason} onChange={e => { setReason(e.target.value); setError(null); }} aria-invalid={!!error} data-autofocus data-testid="textarea-admin-reason" />
      <small className={error ? 'aup-error' : ''}>{error ?? `At least ${MIN_REASON_LENGTH} characters. Recorded in the audit log.`}</small>
    </label>
    <RoleNotice permission={PERMISSION[action]} />
  </AdminModal>;
}
