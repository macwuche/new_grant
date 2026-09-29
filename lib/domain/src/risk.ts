import type { DemoState } from './model';
import { findApplicant } from './applicants';

// Automated fraud risk score (0–100). A transparent sum of weighted signals so
// staff can see why an applicant scored as they did. Device and network
// signals are fictional seed values; a real platform would collect them at sign-in.

export type RiskLevel = 'Low' | 'Medium' | 'High';
export type RiskFactor = { label: string; points: number };
export type RiskAssessment = { score: number; level: RiskLevel; factors: RiskFactor[] };

export const RISK_MEDIUM = 30;
export const RISK_HIGH = 60;

const DAY = 86_400_000;
const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');
export const riskLevel = (score: number): RiskLevel => score >= RISK_HIGH ? 'High' : score >= RISK_MEDIUM ? 'Medium' : 'Low';

export function assessRisk(state: DemoState, applicantId: string, now: Date): RiskAssessment {
  const person = findApplicant(state, applicantId);
  if (!person) return { score: 0, level: 'Low', factors: [] };
  const { kyc, signals, destinationChangedAt } = person.account;
  const since = (days: number) => now.getTime() - days * DAY;
  const factors: RiskFactor[] = [];
  const add = (when: boolean, label: string, points: number) => { if (when) factors.push({ label, points }); };

  add(!person.identityVerified, 'Identity not verified', 20);
  add(kyc.status === 'Rejected', 'Identity check was rejected', 15);
  add(!!kyc.nameOnDocument && normalizeName(kyc.nameOnDocument) !== normalizeName(person.name), `Name on ID (“${kyc.nameOnDocument}”) doesn't match the profile`, 20);
  add(new Date(`${person.joined}T00:00:00`).getTime() > since(30), 'Account less than 30 days old', 10);
  add(signals.ipCountry !== 'Unknown' && signals.ipCountry !== person.country, `Signs in from ${signals.ipCountry}; profile says ${person.country}`, 20);
  add(signals.sharedDeviceWith.length > 0, `Device shared with ${signals.sharedDeviceWith.length} other account${signals.sharedDeviceWith.length === 1 ? '' : 's'}`, 25);

  const mine = state.transactions.filter(t => t.applicantId === applicantId);
  const recent = (type: string, days: number) => mine.filter(t => t.type === type && new Date(t.createdAt).getTime() >= since(days));
  const deposits = recent('Deposit', 7).length;
  const payouts = recent('Withdrawal', 7).length;
  add(deposits >= 3, `${deposits} deposits announced in 7 days`, 15);
  add(payouts >= 2, `${payouts} payout requests in 7 days`, 15);
  add(recent('Deposit', 30).some(t => t.status !== 'Failed' && t.status !== 'Cancelled' && t.amount >= state.treasury.highValueDeposit), 'High-value deposit in the last 30 days', 10);
  add(!!destinationChangedAt && new Date(destinationChangedAt).getTime() >= since(7), 'Payout details changed in the last 7 days', 15);
  add(state.applications.some(a => a.applicantId === applicantId && a.escalation?.status === 'Open'), 'Application escalated to security', 10);

  const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
  return { score, level: riskLevel(score), factors: factors.sort((a, b) => b.points - a.points) };
}
