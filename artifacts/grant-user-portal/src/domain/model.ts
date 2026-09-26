// Domain model shared by the applicant portal and the admin review workspace.
// Shapes mirror what the future API will return, so the local store can be
// swapped for server calls without changing the pages.

export type Tier = 1 | 2 | 3;

export type ProgramStatus = 'Draft' | 'Open' | 'Closed';

export type ProgramChange = { at: string; by: string; summary: string };

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
  /** Record version for stale-write checks. */
  updatedAt: string;
  /** Who changed what, newest last. */
  changeLog: ProgramChange[];
};

/** Fields a program manager edits directly. */
export type GrantInput = Pick<Grant, 'name' | 'summary' | 'focus' | 'maxFunding' | 'minimumRequest' | 'budget' | 'deadline' | 'minimumTier' | 'requirements' | 'requiresRegistration'>;

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
  createdAt: string;
  /** Doubles as the record version for stale-write checks. */
  updatedAt: string;
  submittedAt: string | null;
  reviewer: string | null;
  awardedAmount: number | null;
  history: ApplicationEvent[];
  internalNotes: InternalNote[];
};

export type ApplicationInput = Pick<Application, 'businessName' | 'requestedAmount' | 'registrationNumber' | 'purpose' | 'checklist'>;

export type TransactionType = 'Grant' | 'Deposit' | 'Withdrawal' | 'Card fee';
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
  updatedAt: string;
  changeLog: ProgramChange[];
};

export type TreasuryInput = Omit<Treasury, 'updatedAt' | 'changeLog'>;

/** Staff activity feed entry (shared by the demo staff team). */
export type StaffEvent = {
  id: string;
  at: string;
  kind: 'application' | 'deposit' | 'withdrawal' | 'card';
  title: string;
  body: string;
  /** Admin route to open. */
  href: string;
  highlight: boolean;
  read: boolean;
};

export type PayoutMethod = { id: string; type: string; label: string };

export type Profile = {
  name: string;
  email: string;
  phone: string;
  address: string;
  tier: Tier;
  identityVerified: boolean;
  twoFactor: boolean;
};

/** Other (fictional) applicants visible in the admin directory. */
export type ApplicantSummary = { id: string; name: string; email: string; sector: string; country: string; verified: boolean; joined: string };

export type CardsState = {
  virtual: { lastFour: string; dailyLimit: number; frozen: boolean };
  physical: { status: 'Not requested' | 'Requested'; dailyLimit: number };
};

export type DemoState = {
  version: 4;
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
  nextId: number;
};

export type Result<T = DemoState> = { ok: true; state: T; message: string; id?: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };
