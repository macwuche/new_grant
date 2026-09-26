import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, CreditCard, FileText, ShieldAlert, UserRound } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { markAllStaffEventsRead, markStaffEventRead, staffFeed, staffUnread } from '@/domain/activity';
import { useDemoStore } from '@/domain/store';
import type { StaffEvent } from '@/domain/model';

const kindIcon: Record<StaffEvent['kind'], typeof Bell> = { application: FileText, deposit: ArrowDownLeft, withdrawal: ArrowUpRight, card: CreditCard, security: ShieldAlert, account: UserRound };

export function ActivityItem({ event, onOpen, compact = false }: { event: StaffEvent; onOpen: (event: StaffEvent) => void; compact?: boolean }) {
  const Icon = kindIcon[event.kind];
  return <button type="button" className={`admin-activity-item ${event.read ? '' : 'unread'} ${event.highlight ? 'highlight' : ''} ${compact ? 'compact' : ''}`} onClick={() => onOpen(event)} data-testid={`activity-${event.id}`}>
    <span className="admin-activity-icon"><Icon size={14} /></span>
    <span className="admin-activity-copy"><strong>{event.title}{event.highlight && <span className="admin-flag">{event.kind === 'security' ? 'Security' : event.kind === 'withdrawal' ? 'Two sign-offs' : 'High value'}</span>}</strong><span>{event.body}</span><small>{formatDistanceToNow(new Date(event.at), { addSuffix: true })}</small></span>
  </button>;
}

export function useOpenActivity() {
  const { run } = useDemoStore();
  const [, navigate] = useLocation();
  return (event: StaffEvent) => { run(s => markStaffEventRead(s, event.id)); navigate(event.href); };
}

/** Topbar bell for staff: applicant actions that may need attention. */
export function AdminActivityMenu() {
  const { state, run } = useDemoStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const openItem = useOpenActivity();
  const unread = staffUnread(state);
  const items = staffFeed(state).slice(0, 15);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return <div className="admin-activity-wrap" ref={wrapRef}>
    <button ref={buttonRef} type="button" className="admin-icon-button admin-activity-button" aria-label={unread ? `Team activity, ${unread} unread` : 'Team activity'} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(v => !v)} data-testid="button-admin-activity">
      <Bell size={16} />{unread > 0 && <span className="admin-activity-count" data-testid="text-admin-activity-count">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <div className="admin-activity-panel" id={panelId} role="region" aria-label="Team activity" data-testid="panel-admin-activity">
      <div className="admin-activity-head"><strong><Activity size={14} /> Team activity</strong>{unread > 0 && <button type="button" onClick={() => run(markAllStaffEventsRead)} data-testid="button-admin-activity-read-all">Mark all as read</button>}</div>
      {items.length ? <div className="admin-activity-list">{items.map(e => <ActivityItem key={e.id} event={e} onOpen={ev => { setOpen(false); openItem(ev); }} />)}</div> : <p className="admin-review-hint" style={{ padding: 16 }}>No activity yet.</p>}
      <div className="admin-activity-foot"><Link href="/admin" onClick={() => setOpen(false)}>Overview</Link><span>Shared by the demo staff team · browser only</span></div>
    </div>}
  </div>;
}
