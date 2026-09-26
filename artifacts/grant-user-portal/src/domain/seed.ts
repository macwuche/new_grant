import type { Application, ApplicationEvent, DemoState, Grant, PayoutMethod } from './model';

/** The demo applicant who uses the applicant portal. */
export const CURRENT_APPLICANT_ID = 'APL-1001';
/** The demo staff member using the admin workspace. No real staff identity exists yet. */
export const DEMO_REVIEWER = 'Avery Taylor';

// Illustrative catalog. Amounts, budgets, tiers, and deadlines are examples, not policy.
export const grants: Grant[] = [
  { id: 'momentum', name: 'Business Momentum', summary: 'Working capital for small businesses ready for their next chapter.', maxFunding: 12500, minimumRequest: 1000, budget: 150000, deadline: '2026-11-20', minimumTier: 2, requirements: ['Business registration number', '90-day bank statement', 'A short use-of-funds plan'], requiresRegistration: true },
  { id: 'green', name: 'Green Transition', summary: 'Support for practical energy upgrades that reduce operating costs.', maxFunding: 18000, minimumRequest: 2500, budget: 200000, deadline: '2026-12-11', minimumTier: 2, requirements: ['Project quote or estimate', 'Business registration number', 'Impact statement'], requiresRegistration: true },
  { id: 'creative', name: 'Creative Practice', summary: 'Flexible funding for independent makers and creative studios.', maxFunding: 8500, minimumRequest: 500, budget: 60000, deadline: '2027-01-15', minimumTier: 1, requirements: ['Portfolio link', 'Project budget', 'Professional reference'], requiresRegistration: false },
  { id: 'community', name: 'Community Roots', summary: 'Help local organizations build more resilient neighborhoods.', maxFunding: 22000, minimumRequest: 5000, budget: 250000, deadline: '2027-02-05', minimumTier: 3, requirements: ['Organization registration', 'Community plan', 'Annual operating budget'], requiresRegistration: true },
];

export const payoutMethods: PayoutMethod[] = [
  { id: 'bank', type: 'Bank transfer', label: '•••• 0842 · Meridian checking' },
  { id: 'mobile', type: 'Mobile money', label: '+1 (415) 555-0148' },
];

const ev = (status: ApplicationEvent['status'], at: string, note: string, actor: ApplicationEvent['actor'] = status === 'Draft' || status === 'Submitted' ? 'Applicant' : 'Reviewer'): ApplicationEvent => ({ status, at, actor, note });
const allRequirements = (grantId: string) => grants.find(g => g.id === grantId)!.requirements;

function application(fields: Pick<Application, 'id' | 'applicantId' | 'grantId' | 'status' | 'businessName' | 'requestedAmount' | 'purpose' | 'history'> & Partial<Application>): Application {
  const first = fields.history[0]!.at;
  const last = fields.history[fields.history.length - 1]!.at;
  return {
    registrationNumber: '', checklist: fields.status === 'Draft' ? [] : allRequirements(fields.grantId), createdAt: first, updatedAt: last,
    submittedAt: fields.history.find(h => h.status === 'Submitted')?.at ?? null, reviewer: null, awardedAmount: null, internalNotes: [],
    ...fields,
  };
}

export function createSeedState(): DemoState {
  const me = CURRENT_APPLICANT_ID;
  return {
    version: 2,
    profile: { name: 'Alex Morgan', email: 'alex.morgan@example.com', phone: '+1 (415) 555-0148', address: '54 Valencia Street, San Francisco', tier: 2, identityVerified: true, twoFactor: true },
    otherApplicants: [
      { id: 'APL-1042', name: 'Maya Okafor', email: 'maya.okafor@example.org', sector: 'Creative industries', country: 'United Kingdom', verified: true, joined: '2026-06-18' },
      { id: 'APL-1043', name: 'Elias Navarro', email: 'elias.navarro@example.org', sector: 'Retail', country: 'United States', verified: false, joined: '2026-06-16' },
      { id: 'APL-1044', name: 'Nia Campbell', email: 'nia.campbell@example.org', sector: 'Community', country: 'Canada', verified: true, joined: '2026-06-12' },
      { id: 'APL-1045', name: 'Samira Haddad', email: 'samira.haddad@example.org', sector: 'Climate', country: 'United Kingdom', verified: true, joined: '2026-06-09' },
      { id: 'APL-1046', name: 'Theo Mensah', email: 'theo.mensah@example.org', sector: 'Food & beverage', country: 'Ghana', verified: false, joined: '2026-06-06' },
      { id: 'APL-1047', name: 'Priya Shah', email: 'priya.shah@example.org', sector: 'Creative industries', country: 'Canada', verified: true, joined: '2026-06-03' },
    ],
    applications: [
      // The demo applicant's own records.
      application({
        id: 'APP-2048', applicantId: me, grantId: 'momentum', status: 'Under review', businessName: 'Morgan Studio', requestedAmount: 7800, registrationNumber: 'CA-5521904', reviewer: DEMO_REVIEWER,
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
        id: 'APP-2050', applicantId: 'APL-1045', grantId: 'green', status: 'Submitted', businessName: 'Haddad Grocers', requestedAmount: 12800, registrationNumber: 'GB-09921733',
        purpose: 'Practical energy upgrades across a small independent storefront: LED lighting, efficient refrigeration, and insulation.',
        history: [ev('Draft', '2026-09-12T08:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-20T16:45:00.000Z', 'Application submitted.')],
      }),
      application({
        id: 'APP-2049', applicantId: 'APL-1044', grantId: 'community', status: 'Under review', businessName: 'Eastside Community Kitchen', requestedAmount: 16250, registrationNumber: 'CA-NP-44120', reviewer: DEMO_REVIEWER,
        purpose: 'Additional kitchen capacity for local food programming, including a second prep line and cold storage.',
        history: [ev('Draft', '2026-09-01T11:00:00.000Z', 'Draft started.'), ev('Submitted', '2026-09-08T09:10:00.000Z', 'Application submitted.'), ev('Under review', '2026-09-16T14:30:00.000Z', 'A reviewer has started reviewing your application.')],
      }),
      application({
        id: 'APP-2052', applicantId: 'APL-1043', grantId: 'momentum', status: 'Changes requested', businessName: 'Navarro Corner Shop', requestedAmount: 7800, registrationNumber: 'US-TX-7781', reviewer: DEMO_REVIEWER,
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
      { id: 'TX-84002', applicantId: me, type: 'Deposit', description: 'Demo account funding', amount: 450, status: 'Completed', createdAt: '2026-08-06T13:00:00.000Z' },
      { id: 'TX-83984', applicantId: me, type: 'Card fee', description: 'Virtual card issuance', amount: -8.5, status: 'Completed', createdAt: '2026-07-30T09:00:00.000Z' },
      { id: 'TX-84077', applicantId: me, type: 'Withdrawal', description: 'Payout to Bank transfer', amount: -125, status: 'Pending', createdAt: '2026-09-20T14:45:00.000Z' },
    ],
    cards: {
      virtual: { lastFour: '4826', dailyLimit: 1500, frozen: false },
      physical: { status: 'Not requested', dailyLimit: 2500 },
    },
    nextId: 2102,
  };
}
