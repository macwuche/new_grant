import type { RiskAssessment } from '@workspace/domain/risk';

const TONE = { Low: 'active', Medium: 'submitted', High: 'declined' } as const;

/** Score with level; colour is backed by the level word, never colour alone. */
export function RiskBadge({ risk }: { risk: RiskAssessment }) {
  return <span className={`admin-badge ${TONE[risk.level]}`} title={risk.factors.map(f => `${f.label} (+${f.points})`).join('\n') || 'No risk signals'} data-testid="status-admin-risk">{risk.level} · {risk.score}</span>;
}
