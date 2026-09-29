import { BUILTIN_METHOD_DETAILS } from './withdrawalMethods';
import type { AccountControls, Application, ApplicationEvent, DemoState, Grant, Notification, ProgramQuestion, SavedPayoutDetails, StaffEvent, StaffMember, Treasury } from './model';

/** The demo applicant who uses the applicant portal. */
export const CURRENT_APPLICANT_ID = 'APL-1001';
/** The demo staff member using the admin workspace. No real staff identity exists yet. */
export const DEMO_REVIEWER = 'Avery Taylor';
/** The demo finance operator who processes payouts — deliberately not the reviewer. */
export const DEMO_FINANCE = 'Jordan Lee';
/** The demo program manager who edits the grant catalog. */
export const DEMO_PROGRAM_MANAGER = 'Sam Rivera';
/** The demo compliance & risk officer (KYC, escalations, second payout sign-off). */
export const DEMO_COMPLIANCE = 'Riley Chen';

/** Fictional staff team. Roles decide what each can do in /admin; see ./staff. */
export function seedStaff(): StaffMember[] {
  return [
    { id: 'STF-1', name: DEMO_PROGRAM_MANAGER, role: 'super', active: true },
    { id: 'STF-2', name: DEMO_REVIEWER, role: 'reviewer', active: true },
    { id: 'STF-3', name: DEMO_FINANCE, role: 'finance', active: true },
    { id: 'STF-4', name: DEMO_COMPLIANCE, role: 'compliance', active: true },
    { id: 'STF-5', name: 'Casey Brooks', role: 'support', active: true },
  ];
}

// Illustrative catalog. Amounts, budgets, tiers, and deadlines are examples, not policy.
const CATALOG_CREATED = '2026-06-01T09:00:00.000Z';
type SeedGrant = Omit<Grant, 'updatedAt' | 'changeLog' | 'questions'>;
const QUESTIONS: Record<string, ProgramQuestion[]> = {
  momentum: [
    { id: 'employees', label: 'How many people does the business employ?', type: 'number', required: true },
    { id: 'trading', label: 'Has the business been trading for at least 12 months?', type: 'yesno', required: true },
  ],
  green: [{ id: 'savings', label: 'Estimated annual energy savings (USD), if known', type: 'number', required: false }],
  community: [{ id: 'residents', label: 'Roughly how many residents will benefit?', type: 'number', required: true }],
};
const catalog: SeedGrant[] = [
  { id: 'momentum', status: 'Open', name: 'Business Momentum', summary: 'Working capital for small businesses ready for their next chapter.', focus: 'Small businesses', maxFunding: 12500, minimumRequest: 1000, budget: 150000, deadline: '2026-11-20', minimumTier: 2, requirements: ['Business registration number', '90-day bank statement', 'A short use-of-funds plan'], requiresRegistration: true },
  { id: 'green', status: 'Open', name: 'Green Transition', summary: 'Support for practical energy upgrades that reduce operating costs.', focus: 'Climate action', maxFunding: 18000, minimumRequest: 2500, budget: 200000, deadline: '2026-12-11', minimumTier: 2, requirements: ['Project quote or estimate', 'Business registration number', 'Impact statement'], requiresRegistration: true },
  { id: 'creative', status: 'Open', name: 'Creative Practice', summary: 'Flexible funding for independent makers and creative studios.', focus: 'Independent makers', maxFunding: 8500, minimumRequest: 500, budget: 60000, deadline: '2027-01-15', minimumTier: 1, requirements: ['Portfolio link', 'Project budget', 'Professional reference'], requiresRegistration: false },
  { id: 'community', status: 'Open', name: 'Community Roots', summary: 'Help local organizations build more resilient neighborhoods.', focus: 'Local organizations', maxFunding: 22000, minimumRequest: 5000, budget: 250000, deadline: '2027-02-05', minimumTier: 3, requirements: ['Organization registration', 'Community plan', 'Annual operating budget'], requiresRegistration: true },
  { id: 'space', status: 'Draft', name: 'Shared Spaces', summary: 'Welcoming, adaptable community spaces for local groups to meet and make.', focus: 'Civic spaces', maxFunding: 14500, minimumRequest: 2000, budget: 90000, deadline: '2027-04-30', minimumTier: 2, requirements: ['Site plan or lease', 'Community partner letter', 'Project budget'], requiresRegistration: true },
];

/** Fresh copies of the seed catalog (callers may keep them in state). */
export function seedGrants(): Grant[] {
  return catalog.map(g => ({
    ...g, requirements: [...g.requirements], questions: (QUESTIONS[g.id] ?? []).map(q => ({ ...q })), updatedAt: CATALOG_CREATED,
    changeLog: [{ at: CATALOG_CREATED, by: DEMO_PROGRAM_MANAGER, summary: g.status === 'Draft' ? 'Created as draft.' : 'Created and published.' }],
  }));
}

/** The demo applicant's remembered payout answers per method (fictional). USDT starts empty. */
export function seedSavedPayoutDetails(): SavedPayoutDetails {
  return {
    bank: { 'bank-name': 'Meridian Bank', 'account-name': 'Alex Morgan', 'account-number': '4403990842' },
    mobile: { phone: '+1 (415) 555-0148', network: 'Other' },
  };
}

const account = (fields: Partial<AccountControls> & Pick<AccountControls, 'kyc' | 'signals'>): AccountControls => ({ status: 'Active', passwordResetRequired: false, twoFactorResetRequired: false, ...fields });
const verifiedKyc = (name: string, documentType: 'Passport' | 'National ID', documentLast4: string, at: string): AccountControls['kyc'] => ({ status: 'Verified', documentType, documentLast4, nameOnDocument: name, submittedAt: at, reviewedAt: at, reviewedBy: DEMO_COMPLIANCE });

/** Account controls, KYC records, and fictional risk signals for every seeded applicant. */
export function seedAccounts(): Record<string, AccountControls> {
  return {
    [CURRENT_APPLICANT_ID]: account({ kyc: verifiedKyc('Alex Morgan', 'Passport', '7731', '2026-06-21T10:00:00.000Z'), signals: { ipCountry: 'United States', sharedDeviceWith: [] } }),
    'APL-1042': account({ kyc: verifiedKyc('Maya Okafor', 'Passport', '1180', '2026-06-19T09:00:00.000Z'), signals: { ipCountry: 'Nigeria', sharedDeviceWith: [] } }),
    'APL-1043': account({ kyc: { status: 'Pending', documentType: 'National ID', documentLast4: '5521', nameOnDocument: 'Eli Ruiz', submittedAt: '2026-09-23T08:40:00.000Z' }, signals: { ipCountry: 'United States', sharedDeviceWith: ['APL-1046'] } }),
    'APL-1044': account({ kyc: verifiedKyc('Nia Campbell', 'National ID', '6602', '2026-06-13T12:00:00.000Z'), signals: { ipCountry: 'Canada', sharedDeviceWith: [] } }),
    'APL-1045': account({ kyc: verifiedKyc('Samira Haddad', 'Passport', '3319', '2026-06-10T15:00:00.000Z'), signals: { ipCountry: 'United Kingdom', sharedDeviceWith: [] } }),
    'APL-1046': account({ kyc: { status: 'Pending', documentType: 'Passport', documentLast4: '0917', nameOnDocument: 'Theo Mensah', submittedAt: '2026-09-24T17:05:00.000Z' }, signals: { ipCountry: 'Ghana', sharedDeviceWith: ['APL-1043'] } }),
    'APL-1047': account({ kyc: verifiedKyc('Priya Shah', 'National ID', '4470', '2026-06-04T11:00:00.000Z'), signals: { ipCountry: 'Canada', sharedDeviceWith: [] } }),
  };
}

const TREASURY_CREATED = '2026-06-01T09:00:00.000Z';
/** Default money settings. Values are illustrative, not approved commercial terms. */
export function seedTreasury(): Treasury {
  return {
    channels: [
      { id: 'bank', name: 'Bank transfer', enabled: true, min: 10, max: 10000, feeRate: 0.0125, feeFixed: 0, feeCap: 14, photoUrl: '', source: 'grant', ...BUILTIN_METHOD_DETAILS['bank']! },
      { id: 'mobile', name: 'Mobile money', enabled: true, min: 10, max: 2000, feeRate: 0.015, feeFixed: 0, feeCap: 10, photoUrl: '', source: 'grant', ...BUILTIN_METHOD_DETAILS['mobile']! },
      { id: 'wire', name: 'Wire transfer', enabled: false, min: 500, max: 50000, feeRate: 0, feeFixed: 25, feeCap: 25, photoUrl: '', source: 'grant', ...BUILTIN_METHOD_DETAILS['wire']! },
      { id: 'crypto', name: 'USDT wallet', enabled: false, min: 50, max: 20000, feeRate: 0.01, feeFixed: 1, feeCap: 20, photoUrl: '', source: 'grant', ...BUILTIN_METHOD_DETAILS['crypto']! },
    ],
    physicalCardFee: 8.5,
    cardDeliveryFee: 3.5,
    minDeposit: 20,
    maxDeposit: 25000,
    depositThreshold: 25,
    highValueDeposit: 1000,
    dualControlThreshold: 2500,
    applicationFee: 0,
    updatedAt: TREASURY_CREATED,
    changeLog: [{ at: TREASURY_CREATED, by: DEMO_FINANCE, summary: 'Initial money settings.' }],
  };
}

const ev = (status: ApplicationEvent['status'], at: string, note: string, actor: ApplicationEvent['actor'] = status === 'Draft' || status === 'Submitted' ? 'Applicant' : 'Reviewer'): ApplicationEvent => ({ status, at, actor, note });
const allRequirements = (grantId: string) => catalog.find(g => g.id === grantId)!.requirements;

function application(fields: Pick<Application, 'id' | 'applicantId' | 'grantId' | 'status' | 'businessName' | 'requestedAmount' | 'purpose' | 'history'> & Partial<Application>): Application {
  const first = fields.history[0]!.at;
  const last = fields.history[fields.history.length - 1]!.at;
  return {
    registrationNumber: '', checklist: fields.status === 'Draft' ? [] : allRequirements(fields.grantId), answers: {}, createdAt: first, updatedAt: last,
    submittedAt: fields.history.find(h => h.status === 'Submitted')?.at ?? null, reviewer: null, awardedAmount: null, internalNotes: [], escalation: null,
    ...fields,
  };
}

export function createSeedState(): DemoState {
  const me = CURRENT_APPLICANT_ID;
  return {
    version: 6,
    grants: seedGrants(),
    notifications: seedNotifications(me),
    treasury: seedTreasury(),
    staffFeed: seedStaffFeed(),
    profile: { name: 'Alex Morgan', email: 'alex.morgan@example.com', phone: '+1 (415) 555-0148', address: '54 Valencia Street, San Francisco', tier: 2, identityVerified: true, twoFactor: true, sector: 'Creative industries', country: 'United States', joined: '2026-06-20' },
    otherApplicants: [
      { id: 'APL-1042', name: 'Maya Okafor', email: 'maya.okafor@example.org', sector: 'Creative industries', country: 'United Kingdom', verified: true, joined: '2026-06-18', tier: 2 },
      { id: 'APL-1043', name: 'Elias Navarro', email: 'elias.navarro@example.org', sector: 'Retail', country: 'United States', verified: false, joined: '2026-06-16', tier: 2 },
      { id: 'APL-1044', name: 'Nia Campbell', email: 'nia.campbell@example.org', sector: 'Community', country: 'Canada', verified: true, joined: '2026-06-12', tier: 3 },
      { id: 'APL-1045', name: 'Samira Haddad', email: 'samira.haddad@example.org', sector: 'Climate', country: 'United Kingdom', verified: true, joined: '2026-06-09', tier: 2 },
      { id: 'APL-1046', name: 'Theo Mensah', email: 'theo.mensah@example.org', sector: 'Food & beverage', country: 'Ghana', verified: false, joined: '2026-06-06', tier: 1 },
      { id: 'APL-1047', name: 'Priya Shah', email: 'priya.shah@example.org', sector: 'Creative industries', country: 'Canada', verified: true, joined: '2026-06-03', tier: 2 },
    ],
    applications: [
      // The demo applicant's own records.
      application({
        id: 'APP-2048', applicantId: me, grantId: 'momentum', status: 'Under review', businessName: 'Morgan Studio', requestedAmount: 7800, registrationNumber: 'CA-5521904', reviewer: DEMO_REVIEWER, answers: { employees: '2', trading: 'Yes' },
        purpose: 'Stock up on materials ahead of the holiday season and cover a part-time assistant for three months.',
        history: [ev('Draft', '2026-08-28T10:12:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-02T09:30:00.000Z', 'Application submitted.'), ev('Under review', '2026-09-11T15:40:00.000Z', 'A reviewer has started reviewing your application.')],
      }),
      application({
        id: 'APP-1932', applicantId: me, grantId: 'creative', status: 'Approved', businessName: 'Morgan Studio', requestedAmount: 4200, awardedAmount: 4200, reviewer: DEMO_REVIEWER,
        purpose: 'Fund a limited ceramics series and a booth at two regional craft fairs.',
        history: [ev('Draft', '2026-07-20T12:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-07-24T08:15:00.000Z', 'Application submitted.'), ev('Under review', '2026-07-30T10:00:00.000Z', 'A reviewer has started reviewing your application.'), ev('Approved', '2026-08-14T11:05:00.000Z', 'Approved for $4,200.00. The award has been added to your grant balance.')],
      }),
      application({
        id: 'APP-2101', applicantId: me, grantId: 'green', status: 'Draft', businessName: 'Morgan Studio', requestedAmount: 12000, registrationNumber: 'CA-5521904', purpose: '',
        history: [ev('Draft', '2026-09-18T16:20:00.000Z', 'Draft started.')],
      }),
      // Other applicants' submitted work for the review queue. Their drafts are private and never seeded.
      application({
        id: 'APP-2051', applicantId: 'APL-1042', grantId: 'creative', status: 'Under review', businessName: 'Okafor Print Studio', requestedAmount: 7400, reviewer: DEMO_REVIEWER,
        purpose: 'Equipment and workshop materials for a shared neighborhood print studio.',
        history: [ev('Draft', '2026-09-10T09:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-14T10:20:00.000Z', 'Application submitted.'), ev('Under review', '2026-09-21T13:00:00.000Z', 'A reviewer has started reviewing your application.')],
        internalNotes: [{ at: '2026-09-21T13:05:00.000Z', author: DEMO_REVIEWER, text: 'Portfolio is strong. Waiting to confirm the press quote matches the budget.' }],
      }),
      application({
        id: 'APP-2050', applicantId: 'APL-1045', grantId: 'green', status: 'Submitted', businessName: 'Haddad Grocers', requestedAmount: 12800, registrationNumber: 'GB-09921733', answers: { savings: '3400' },
        purpose: 'Practical energy upgrades across a small independent storefront: LED lighting, efficient refrigeration, and insulation.',
        history: [ev('Draft', '2026-09-12T08:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-20T16:45:00.000Z', 'Application submitted.')],
      }),
      application({
        id: 'APP-2049', applicantId: 'APL-1044', grantId: 'community', status: 'Under review', businessName: 'Eastside Community Kitchen', requestedAmount: 16250, registrationNumber: 'CA-NP-44120', reviewer: DEMO_REVIEWER, answers: { residents: '1200' },
        purpose: 'Additional kitchen capacity for local food programming, including a second prep line and cold storage.',
        history: [ev('Draft', '2026-09-01T11:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-08T09:10:00.000Z', 'Application submitted.'), ev('Under review', '2026-09-16T14:30:00.000Z', 'A reviewer has started reviewing your application.')],
      }),
      application({
        id: 'APP-2052', applicantId: 'APL-1043', grantId: 'momentum', status: 'Changes requested', businessName: 'Navarro Corner Shop', requestedAmount: 7800, registrationNumber: 'US-TX-7781', reviewer: DEMO_REVIEWER, answers: { employees: '1', trading: 'No' },
        purpose: 'Inventory and equipment to support a second year of trading.',
        history: [ev('Draft', '2026-09-03T10:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-06T12:00:00.000Z', 'Application submitted.'), ev('Under review', '2026-09-12T09:30:00.000Z', 'A reviewer has started reviewing your application.'), ev('Changes requested', '2026-09-15T15:00:00.000Z', 'Please add a breakdown of equipment costs to your use-of-funds plan.')],
      }),
      application({
        id: 'APP-2047', applicantId: 'APL-1047', grantId: 'creative', status: 'Submitted', businessName: 'Shah Ceramics', requestedAmount: 4950,
        purpose: 'Portable tools and materials for accessible ceramics sessions in libraries and community centers.',
        history: [ev('Draft', '2026-09-15T15:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-22T11:30:00.000Z', 'Application submitted.')],
      }),
    ],
    transactions: [
      { id: 'TX-84019', applicantId: me, type: 'Grant', description: 'Creative Practice award (APP-1932)', amount: 4200, status: 'Completed', createdAt: '2026-08-14T11:05:00.000Z' },
      { id: 'TX-84002', applicantId: me, type: 'Deposit', description: 'Deposit via Bank transfer', amount: 450, status: 'Completed', createdAt: '2026-08-05T10:00:00.000Z', method: 'bank', reference: 'ARC-1990', processedAt: '2026-08-06T13:00:00.000Z', processedBy: DEMO_FINANCE },
      { id: 'TX-82090', applicantId: 'APL-1042', type: 'Deposit', description: 'Deposit via Bank transfer', amount: 1500, status: 'Pending', createdAt: '2026-09-24T10:00:00.000Z', method: 'bank', reference: 'ARC-2090' },
      { id: 'TX-83984', applicantId: me, type: 'Card fee', description: 'Virtual card issuance', amount: -8.5, status: 'Completed', createdAt: '2026-07-30T09:00:00.000Z' },
      { id: 'TX-84077', applicantId: me, type: 'Withdrawal', description: 'Payout to Bank transfer', amount: -125, status: 'Pending', createdAt: '2026-09-20T14:45:00.000Z', method: 'bank', fee: 1.56, destination: 'Bank transfer · Meridian Bank', source: 'grant',
        payoutDetails: [{ fieldId: 'bank-name', label: 'Bank name', value: 'Meridian Bank' }, { fieldId: 'account-name', label: 'Account holder name', value: 'Alex Morgan' }, { fieldId: 'account-number', label: 'Account number', value: '4403990842' }] },
    ],
    cards: {
      virtual: { lastFour: '4826', dailyLimit: 1500, frozen: false, pin: '3071' },
      physical: { status: 'Not requested', dailyLimit: 2500 },
    },
    savedPayoutDetails: seedSavedPayoutDetails(),
    accounts: seedAccounts(),
    staff: seedStaff(),
    actingStaffId: 'STF-1',
    audit: [],
    lockdown: null,
    nextId: 2102,
  };
}

function seedNotifications(me: string): Notification[] {
  return [
    { id: 'NT-1', applicantId: me, at: '2026-08-14T11:05:00.000Z', title: 'Creative Practice approved', body: 'Approved for $4,200.00. The award has been added to your grant balance.', href: '/applications/APP-1932', read: true },
    { id: 'NT-2', applicantId: me, at: '2026-09-11T15:40:00.000Z', title: 'Business Momentum is under review', body: 'A reviewer has started reviewing your application.', href: '/applications/APP-2048', read: false },
  ];
}

function seedStaffFeed(): StaffEvent[] {
  return [
    { id: 'FD-4', at: '2026-09-24T10:00:00.000Z', kind: 'deposit', title: 'High-value deposit announced: $1,500.00', body: 'Maya Okafor · Bank transfer · reference ARC-2090', href: '/admin/deposits', highlight: true, read: false },
    { id: 'FD-3', at: '2026-09-22T11:30:00.000Z', kind: 'application', title: 'New application APP-2047', body: 'Priya Shah · Creative Practice · $4,950', href: '/admin/applications', highlight: false, read: false },
    { id: 'FD-2', at: '2026-09-20T16:45:00.000Z', kind: 'application', title: 'New application APP-2050', body: 'Samira Haddad · Green Transition · $12,800', href: '/admin/applications', highlight: false, read: true },
    { id: 'FD-1', at: '2026-09-20T14:45:00.000Z', kind: 'withdrawal', title: 'Payout request TX-84077', body: 'Alex Morgan · $125.00 via Bank transfer', href: '/admin/payouts', highlight: false, read: false },
  ];
}
