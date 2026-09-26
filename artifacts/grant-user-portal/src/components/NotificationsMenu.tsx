import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Bell } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { markAllNotificationsRead, markNotificationRead, ownNotifications, unreadCount } from '@workspace/domain/notifications';
import { useDemoStore } from '@/lib/store';

/** Topbar bell: the applicant's review, payout, and program updates. */
export function NotificationsMenu() {
  const { state, run } = useDemoStore();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const items = ownNotifications(state).slice(0, 20);
  const unread = unreadCount(state);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openItem = (id: string, href: string) => {
    run(s => markNotificationRead(s, id));
    setOpen(false);
    navigate(href);
  };

  return <div className="notif-wrap" ref={wrapRef}>
    <button ref={buttonRef} className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(v => !v)} data-testid="button-notifications">
      <Bell size={17} />{unread > 0 && <span className="notif-count" data-testid="text-notification-count">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <div className="notif-panel" id={panelId} role="region" aria-label="Notifications" data-testid="panel-notifications">
      <div className="notif-head"><strong>Notifications</strong>{unread > 0 && <button className="link-text" onClick={() => run(markAllNotificationsRead)} data-testid="button-mark-all-read">Mark all as read</button>}</div>
      {items.length ? <ul className="notif-list">{items.map(n => <li key={n.id}>
        <button className={`notif-item ${n.read ? '' : 'unread'}`} onClick={() => openItem(n.id, n.href)} data-testid={`notification-${n.id}`}>
          <span className="notif-item-title">{!n.read && <span className="notif-unread-dot" aria-label="Unread" />}{n.title}</span>
          <span className="notif-item-body">{n.body}</span>
          <span className="notif-item-time">{formatDistanceToNow(new Date(n.at), { addSuffix: true })}</span>
        </button>
      </li>)}</ul> : <p className="notif-empty">You're all caught up. Updates about your applications and payouts will appear here.</p>}
      <p className="notif-foot">In-app only. Email notifications aren't connected yet.</p>
    </div>}
  </div>;
}
