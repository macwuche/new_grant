// Domain model shared by the applicant portal and the admin review workspace.
// Shapes mirror what the future API will return, so the local store can be
// swapped for server calls without changing the pages.

export type Tier = 1 | 2 | 3;

export type ProgramStatus = 'Draft' | 'Open' | 'Closed';

export type ProgramChange = { at: string; by: string; summary: string };

export type QuestionType = 'text' | 'number' | 'yesno';
/** A program-specific question applicants answer (configured by staff). */
export type ProgramQuestion = { id: string; label: string; type: QuestionType; required: boolean };

export type Grant = {
  id: string;
  /** Draft programs are staff-only; Closed programs take no new applications. */
  status: ProgramStatus;
  name: string;
  summary: string;
  /** Short audience label shown to staff, e.g. "Small businesses". */
  focus: string;
  maxFunding: number;
  minimumRequest: number;
  /** Total funds the program can award this cycle. */
  budget: number;
  /** ISO date (inclusive, end of day local time). */
  deadline: string;
  minimumTier: Tier;
  requirements: string[];
  /** Whether a business/organization registration number is mandatory. */
  requiresRegistration: boolean;
  /** Extra questions applicants answer; locked once anyone submits. */
  questions: ProgramQuestion[];
  /** Record version for stale-write checks. */
  updatedAt: string;
  /** Who changed what, newest last. */
  changeLog: ProgramChange[];
};

/** Fields a program manager edits directly. */
export type GrantInput = Pick<Grant, 'name' | 'summary' | 'focus' | 'maxFunding' | 'minimumRequest' | 'budget' | 'deadline' | 'minimumTier' | 'requirements' | 'requiresRegistration' | 'questions'>;

/** In-app message for an applicant. Created by review and payout rules. */
export type Notification = {
  id: string;
  applicantId: string;
  at: string;
  title: string;
  body: string;
  /** In-app route to open, e.g. /applications/APP-2048. */
  href: string;
  read: boolean;
};

export type ApplicationStatus = 'Draft' | 'Submitted' | 'Under review' | 'Changes requested' | 'Approved' | 'Declined';

export type Actor = 'Applicant' | 'Reviewer';

/** Status history. `note` is visible to the applicant. */
export type ApplicationEvent = { status: ApplicationStatus; at: string; actor: Actor; note: string };

/** Staff-only note; never shown in the applicant portal. */
export type InternalNote = { at: string; author: string; text: string };

/** Staff-only: an application sent to compliance for a security check. Blocks approval while open. */
export type Escalation = { at: string; by: string; reason: string; status: 'Open' | 'Cleared'; clearedAt?: string; clearedBy?: string; resolution?: string };

export type Application = {
  id: string;
  applicantId: string;
  grantId: string;
  status: ApplicationStatus;
  businessName: string;
  requestedAmount: number;
  registrationNumber: string;
  purpose: string;
  /** Requirements the applicant has confirmed they have ready. */
  checklist: string[];
  /** Answers to the program's questions, keyed by question id. */
  answers: Record<string, string>;
  createdAt: string;
  /** Doubles as the record version for stale-write checks. */
  updatedAt: string;
  submittedAt: string | null;
  reviewer: string | null;
  awardedAmount: number | null;
  history: ApplicationEvent[];
  internalNotes: InternalNote[];
  escalation: Escalation | null;
};

export type ApplicationInput = Pick<Application, 'businessName' | 'requestedAmount' | 'registrationNumber' | 'purpose' | 'checklist' | 'answers'>;

export type TransactionType = 'Grant' | 'Deposit' | 'Withdrawal' | 'Card fee' | 'Application fee' | 'Card top-up' | 'Card deduction' | 'Grant adjustment' | 'Deposit adjustment';
/** Why staff adjusted a balance by hand (see ./adjustments.ts). */
export type AdjustmentCategory = 'Grant adjustment' | 'Deposit manual override' | 'Card fee refund' | 'Correction' | 'Fraud freeze';
/** Card top-ups and deductions: the balance on the other side of the move, or 'none' when staff add or remove money outright. */
export type CardCounterpart = 'deposit' | 'grant' | 'none';
export type TransactionStatus = 'Completed' | 'Pending' | 'Failed' | 'Cancelled';

export type Transaction = {
  id: string;
  applicantId: string;
  type: TransactionType;
  description: string;
  /** Signed amount: credits positive, debits negative. */
  amount: number;
  status: TransactionStatus;
  createdAt: string;
  /** Withdrawals: channel id; deposits: deposit method id. */
  method?: string;
  /** Withdrawals only: processing fee taken from the amount, and where it goes. */
  fee?: number;
  destination?: string;
  /** Deposits only: reference the applicant quotes when sending money. */
  reference?: string;
  /** Deposits and withdrawals: set when finance confirms/rejects, or the applicant cancels. */
  processedAt?: string;
  processedBy?: string;
  /** Shown to the applicant when a payout or deposit fails. */
  failureReason?: string;
  /** Withdrawals only: needs a second staff sign-off before it can be paid (set at request time). */
  dualControl?: boolean;
  /** Withdrawals only: the second sign-off, by someone other than whoever marks it paid. */
  releaseApproval?: { by: string; at: string; /** Server records only: the approver's staff id, compared instead of the name. */ byId?: string };
  /** Card top-ups and deductions only (see CardCounterpart). */
  counterpart?: CardCounterpart;
  /** Staff card moves and balance adjustments: the reason, shown to the applicant. */
  note?: string;
  /** Staff balance adjustments (including card credits and debits made from the adjustment form). */
  category?: AdjustmentCategory;
};

export type ChannelId = 'bank' | 'wire' | 'mobile' | 'crypto';

/** A withdrawal channel finance can enable, limit, and price. */
export type PayoutChannel = {
  id: ChannelId;
  name: string;
  enabled: boolean;
  /** Per-transaction limits (USD). */
  min: number;
  max: number;
  /** Fee = min(feeFixed + amount × feeRate, feeCap). */
  feeRate: number;
  feeFixed: number;
  feeCap: number;
};

export type DepositMethodId = 'bank' | 'mobile';

/** Money settings managed by finance. */
export type Treasury = {
  channels: PayoutChannel[];
  physicalCardFee: number;
  cardDeliveryFee: number;
  minDeposit: number;
  maxDeposit: number;
  /** Deposit balance applicants must keep to request a card or a payout. */
  depositThreshold: number;
  /** Deposits at or above this amount are flagged in the staff feed. */
  highValueDeposit: number;
  /** Payouts at or above this amount need two different staff members (release approval + paid). */
  dualControlThreshold: number;
  /** Charged to the deposit balance on first submission of an application; 0 for none. */
  applicationFee: number;
  updatedAt: string;
  changeLog: ProgramChange[];
};

export type TreasuryInput = Omit<Treasury, 'updatedAt' | 'changeLog'>;

/** Staff activity feed entry (shared by the demo staff team). */
export type StaffEvent = {
  id: string;
  at: string;
  kind: 'application' | 'deposit' | 'withdrawal' | 'card' | 'security' | 'account';
  title: string;
  body: string;
  /** Admin route to open. */
  href: string;
  highlight: boolean;
  read: boolean;
};

/** The applicant's saved payout destination per channel (display label, masked). */
export type PayoutDestinations = Partial<Record<ChannelId, string>>;

export type Profile = {
  name: string;
  email: string;
  phone: string;
  address: string;
  tier: Tier;
  identityVerified: boolean;
  twoFactor: boolean;
  sector: string;
  country: string;
  /** ISO date the account was created. */
  joined: string;
  /** ISO date of birth, when given at sign-up. */
  birthDate?: string;
};

/** Other (fictional) applicants visible in the admin directory. */
export type ApplicantSummary = { id: string; name: string; email: string; sector: string; country: string; verified: boolean; joined: string; tier: Tier; phone?: string; address?: string; birthDate?: string };

export type KycStatus = 'Not submitted' | 'Pending' | 'Verified' | 'Rejected';
export type KycDocumentType = 'Passport' | 'National ID' | "Driver's licence";
/** Identity check. Only the last four characters of the document number are kept. */
export type Kyc = {
  status: KycStatus;
  documentType?: KycDocumentType;
  documentLast4?: string;
  nameOnDocument?: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
};

/** Fictional device/network signals a real platform would collect at sign-in. */
export type RiskSignals = { ipCountry: string; sharedDeviceWith: string[] };

/** Staff-managed controls on an applicant account. */
export type AccountControls = {
  status: 'Active' | 'Locked';
  lockReason?: string;
  lockedAt?: string;
  lockedBy?: string;
  passwordResetRequired: boolean;
  twoFactorResetRequired: boolean;
  kyc: Kyc;
  signals: RiskSignals;
  /** Last time a payout destination was added or changed (a fraud signal). */
  destinationChangedAt?: string;
  /** Staff-set card rules for this applicant; defaults in cards.ts when absent. */
  cardSettings?: CardSettings;
  /** Staff switches on what this applicant may do; defaults in accounts.ts when absent. */
  permissions?: AccountPermissions;
};

/** Per-applicant switches staff turn on or off (Feature toggles on the admin profile page). */
export type AccountPermissions = {
  /** Payout requests need a verified identity. */
  payoutKyc: boolean;
  /** Deposits need a verified identity. */
  depositKyc: boolean;
  /** Notifications are also emailed (security notices always are). */
  emailNotifications: boolean;
  /** The applicant may create a virtual card and apply for a physical one (staff can still issue cards). */
  cardApplications: boolean;
  /** The applicant may submit new grant applications (resubmitting after requested changes stays allowed). */
  grantApplications: boolean;
};

/** Which balances an applicant may move onto their card themselves (staff can use either). */
export type CardFunding = 'deposit' | 'grant' | 'both';
export type CardSettings = { funding: CardFunding; /** Cards can't be created until the identity check is verified. */ kycRequired: boolean };

import type { StaffRole } from '@workspace/authz';
export type { StaffRole };
export type StaffMember = { id: string; name: string; role: StaffRole; active: boolean };

export type AuditChange = { field: string; before: string; after: string };
/** Append-only record of a staff action. No rule edits or deletes these. */
export type AuditEvent = {
  id: string;
  at: string;
  staffId: string;
  staffName: string;
  role: StaffRole;
  action: string;
  /** Record acted on: application, transaction, program, applicant, staff id, or 'treasury' / 'security'. */
  target: string;
  applicantId: string | null;
  summary: string;
  changes: AuditChange[];
  /** Applicant's risk score at the time, when an applicant is involved. */
  riskScore: number | null;
  /** Client address the action came from (server-recorded entries only). */
  ip?: string | null;
};

export type Lockdown = { since: string; by: string; reason: string };

export type CardKind = 'virtual' | 'physical';
/**
 * Physical card lifecycle: the applicant applies (shipping address and fee)
 * and the application waits for staff, who approve it with a shipping message
 * (Shipped) or decline it (fee refunded). Staff can also issue a card directly.
 * The applicant activates a shipped card with its last four digits. Staff can
 * cancel a shipped or active card. After a decline or cancellation the
 * applicant may apply again. A physical card needs a virtual card first.
 */
export type PhysicalCardStatus = 'Not requested' | 'Requested' | 'Shipped' | 'Active' | 'Declined' | 'Cancelled';
/** Who froze a card. An applicant can't lift a freeze staff put on; they see the staff note instead. */
export type CardFreeze = { frozenBy?: 'applicant' | 'staff'; frozenReason?: string };
export type ShippingAddress = { name: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string };

export type VirtualCard = { lastFour: string; dailyLimit: number; frozen: boolean; pin: string; createdAt?: string; createdBy?: string } & CardFreeze;
export type PhysicalCard = {
  status: PhysicalCardStatus; dailyLimit: number;
  /** Printed on the card; set when it ships. */
  lastFour?: string;
  frozen?: boolean;
  shippingAddress?: ShippingAddress;
  requestedAt?: string;
  /** The ledger entry for the fees, so a decline can refund them. */
  feeTxId?: string;
  /** Staff issued the card directly (no application, no fee). */
  issuedBy?: string;
  shippedAt?: string; shippedBy?: string; trackingRef?: string;
  /** The message staff wrote when approving or issuing, emailed to the applicant. */
  shippingMessage?: string;
  activatedAt?: string;
  declinedAt?: string; declinedBy?: string; declineReason?: string;
  cancelledAt?: string; cancelledBy?: string; cancelReason?: string;
} & CardFreeze;

/** One card balance (derived from the ledger) is shared by both cards. */
export type CardsState = {
  /** Created by the applicant or staff; null until then. */
  virtual: VirtualCard | null;
  physical: PhysicalCard;
};

export type DemoState = {
  version: 5;
  grants: Grant[];
  notifications: Notification[];
  treasury: Treasury;
  staffFeed: StaffEvent[];
  /** The signed-in demo applicant (the applicant portal's user). */
  profile: Profile;
  otherApplicants: ApplicantSummary[];
  applications: Application[];
  transactions: Transaction[];
  cards: CardsState;
  payoutDestinations: PayoutDestinations;
  /** Keyed by applicant id, for every applicant including the demo user. */
  accounts: Record<string, AccountControls>;
  staff: StaffMember[];
  /** Which staff member the admin workspace acts as. Stands in for a staff session. */
  actingStaffId: string;
  audit: AuditEvent[];
  /** Emergency switch: while set, payouts can't be requested, released, or paid. */
  lockdown: Lockdown | null;
  nextId: number;
  /**
   * Set once staff load the real applicant directory from the API: the demo
   * user (`profile`) is then left out of staff views, and `otherApplicants` and
   * their accounts are never saved to browser storage.
   */
  serverApplicants?: boolean;
  /**
   * Set once applications come from the API (the applicant's own, or the staff
   * review queue). They're reloaded on each visit, so they're never saved to
   * browser storage.
   */
  serverApplications?: boolean;
  /**
   * Set once notifications, the staff feed, or the audit log come from the API.
   * They're reloaded on each visit, so they're never saved to browser storage.
   */
  serverActivity?: boolean;
  /**
   * Set once the ledger, cards, payout destinations, money settings, and
   * lockdown come from the API. The ledger, cards, and destinations are
   * reloaded on each visit, so they're never saved to browser storage.
   */
  serverMoney?: boolean;
};

export type Result<T = DemoState> = { ok: true; state: T; message: string; id?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
