import type { ComponentType } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowRight, Banknote, ClipboardList, FileText, Info, Landmark, Mail, Palette, ShieldCheck, Users, WalletCards, type LucideIcon } from 'lucide-react';
import { hasPlaceholderDetails } from '@workspace/domain/depositMethods';
import { useAppName } from '@/lib/appName';
import { useSession } from '@/lib/session';
import { useDemoStore } from '@/lib/store';
import { AdminEmailSettings } from './AdminEmailSettings';
import { AdminTreasurySettings } from './AdminTreasurySettings';
import { AdminDepositMethods, AdminWithdrawalMethods } from './AdminPaymentMethods';
import { AdminTeamServer, AdminTeamSettings } from './AdminStaff';
import { AppNameSettings } from './AppNameSettings';
import { BrandColorSettings } from './BrandColorSettings';
import { BrandImageSettings, EmailBrandSettings } from './BrandImageSettings';
import './AdminSettings.css';

// Admin settings, one section per area. /admin/settings lists the sections as
// cards; /admin/settings/<id> shows one. A new feature gets its own entry in
// SETTINGS_SECTIONS (id, card text, a one-line status, and its page).

type SettingsSection = {
  id: string;
  title: string;
  icon: LucideIcon;
  /** What the section is for, on its card and page. */
  description: string;
  /** Who can change it (shown on the card). */
  access: string;
  /** A short live status for the card, e.g. "3 of 4 channels on". */
  Status?: ComponentType;
  Page: ComponentType;
};

const useSignedIn = () => useSession().status === 'signedIn';

function EmailPage() { return <AdminEmailSettings signedIn={useSignedIn()} />; }
function TeamPage() { return useSignedIn() ? <AdminTeamServer /> : <AdminTeamSettings />; }
function BrandingPage() { return <><AppNameSettings /><BrandImageSettings /><BrandColorSettings /><EmailBrandSettings /></>; }

function MoneyStatus() {
  const { depositThreshold } = useDemoStore().state.treasury;
  return <>Reserve ${depositThreshold.toLocaleString('en-US')} · card fees</>;
}
function MethodsStatus() {
  const { channels } = useDemoStore().state.treasury;
  return <>{channels.filter(c => c.enabled).length} of {channels.length} available to users</>;
}
function DepositMethodsStatus() {
  const { depositMethods } = useDemoStore().state.treasury;
  const samples = depositMethods.filter(m => m.enabled && hasPlaceholderDetails(m)).length;
  return <>{depositMethods.filter(m => m.enabled).length} of {depositMethods.length} available to users{samples ? ` · ${samples} with sample details` : ''}</>;
}
function BrandingStatus() { const b = useAppName(); return <>Name: {b.name}{b.logoUrl ? ' · logo' : ''}{b.brandColor ? ` · ${b.brandColor}` : ''}</>; }
function AppInfoStatus() { return <>{useSignedIn() ? 'Signed in · server records' : 'Preview · this browser only'}</>; }
function EmailStatus() { return <>{useSignedIn() ? 'Sending, domain, sign-up emails' : 'Not active in preview mode'}</>; }

function AppInfoPage() {
  const signedIn = useSignedIn();
  const { name } = useAppName();
  return <div className="admin-settings-grid">
    <section className="admin-panel"><div className="admin-panel-head"><div><h2>Workspace configuration</h2><p>Where program controls could live. These settings can't be changed here yet.</p></div></div>
      <div className="admin-setting-item"><ShieldCheck size={18} /><div><strong>Policy documents</strong><p>Future home for eligibility guidance, terms, and privacy documents. No policy is uploaded or published yet.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><Users size={18} /><div><strong>Applicant sectors</strong><p>Future controls for the sector options applicants can choose when building a profile.</p></div><span>NOT CONNECTED</span></div>
      <div className="admin-setting-item"><ClipboardList size={18} /><div><strong>Review stages</strong><p>The review flow is fixed for now: Submitted → Under review → Approved, Declined, or Changes requested (back to the applicant).</p></div><span>FIXED</span></div>
      <div className="admin-setting-item"><FileText size={18} /><div><strong>Program criteria</strong><p>Award range, deadline, tier, requirements, and custom questions are edited per program under Grant programs.</p></div><span>PER PROGRAM</span></div>
    </section>
    <div className="admin-grid">
      <section className="admin-panel"><div className="admin-panel-head"><div><h2>Example sectors</h2><p>Illustrative labels, not live choices.</p></div></div><div className="admin-sector-list"><span>Creative industries</span><span>Retail</span><span>Community</span><span>Climate</span><span>Food &amp; beverage</span></div></section>
      <section className="admin-panel"><div className="admin-panel-head"><div><h2>About this workspace</h2><p>How this copy of {name} is running.</p></div></div>
        <div className="admin-mini-stat"><span>Mode</span><strong>{signedIn ? 'Signed in' : 'Preview'}</strong></div>
        <div className="admin-mini-stat"><span>Staff sign-in</span><strong>{signedIn ? 'Supabase Auth' : 'Not enabled'}</strong></div>
        <div className="admin-mini-stat"><span>Role checks</span><strong>{signedIn ? 'Enforced by the API' : 'Sample roles, this browser'}</strong></div>
        <div className="admin-mini-stat"><span>Data source</span><strong>{signedIn ? 'Server database' : 'This browser'}</strong></div>
      </section>
    </div>
  </div>;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'email', title: 'Email', icon: Mail, access: 'Super admin', Status: EmailStatus, Page: EmailPage,
    description: 'Resend connection, sender and team mailbox, sending domain and DNS, webhook, sign-up verification, and delivery status.' },
  { id: 'money', title: 'Money', icon: Banknote, access: 'Finance', Status: MoneyStatus, Page: AdminTreasurySettings,
    description: 'Card fees, the deposit reserve, and the two-person thresholds for payouts and deposits. Commission is set on each grant program.' },
  { id: 'deposit-methods', title: 'Deposit methods', icon: Landmark, access: 'Finance', Status: DepositMethodsStatus, Page: AdminDepositMethods,
    description: 'How users add funds: where to send the money, each method\'s photo, limits, charges, processing time, instructions, proof of payment, and the form users fill in.' },
  { id: 'withdrawal-methods', title: 'Withdrawal methods', icon: WalletCards, access: 'Finance', Status: MethodsStatus, Page: AdminWithdrawalMethods,
    description: 'How users are paid out: each method\'s photo, limits, charges, processing time, instructions, balance, and the form users fill in.' },
  { id: 'team', title: 'Team & roles', icon: Users, access: 'Super admin', Page: TeamPage,
    description: 'Who is on the grant team, their roles, and what each role can do.' },
  { id: 'branding', title: 'App branding', icon: Palette, access: 'Super admin', Status: BrandingStatus, Page: BrandingPage,
    description: 'The name, logo, favicon, and colours shown everywhere, and how emails look.' },
  { id: 'app-info', title: 'App info', icon: Info, access: 'Everyone on the team', Status: AppInfoStatus, Page: AppInfoPage,
    description: 'How this workspace is running, and the configuration that is fixed or still to come.' },
];

export const findSettingsSection = (id: string | undefined) => SETTINGS_SECTIONS.find(s => s.id === id);

/** /admin/settings: one card per section. */
export function SettingsOverview() {
  return <div className="admin-settings-cards" data-testid="list-settings-sections">
    {SETTINGS_SECTIONS.map(({ id, title, icon: Icon, description, access, Status }) =>
      <Link key={id} href={`/admin/settings/${id}`} className="admin-settings-card" data-testid={`link-settings-${id}`}>
        <span className="admin-settings-card-icon"><Icon size={19} /></span>
        <span className="admin-settings-card-body">
          <strong>{title}</strong>
          <span className="admin-settings-card-text">{description}</span>
          {Status && <span className="admin-settings-card-status"><Status /></span>}
        </span>
        <span className="admin-settings-card-foot"><span>{access}</span><ArrowRight size={15} aria-hidden="true" /></span>
      </Link>)}
  </div>;
}

/** /admin/settings/<id>: one section, with a way back to the list. */
export function SettingsSectionPage({ id }: { id: string }) {
  const section = findSettingsSection(id);
  const back = <Link href="/admin/settings" className="admin-settings-back" data-testid="link-settings-back"><ArrowLeft size={14} /> All settings</Link>;
  if (!section) return <>{back}<section className="admin-panel"><div className="admin-panel-head"><div><h2>No such settings section</h2><p>It may have moved. Pick a section from the list.</p></div></div></section></>;
  const { Page, title, description, icon: Icon } = section;
  return <>
    {back}
    <div className="admin-settings-section-head" data-testid={`panel-settings-${id}`}><span className="admin-settings-card-icon"><Icon size={19} /></span><div><h2>{title}</h2><p>{description}</p></div></div>
    <Page />
  </>;
}

/** The settings page for the admin router: the list, or one section. */
export function AdminSettings({ sectionId }: { sectionId?: string }) {
  return sectionId ? <SettingsSectionPage id={sectionId} /> : <SettingsOverview />;
}
