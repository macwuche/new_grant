import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

// A centred dialog for the admin workspace: traps focus, closes on Escape or a
// click on the backdrop, and returns focus to whatever opened it.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AdminModal({ title, subtitle, onClose, children, footer, wide = false, testId }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const [head, tail] = [items[0]!, items[items.length - 1]!];
      if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
      else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = overflow; opener?.focus?.(); };
  }, []);

  return <div className="aup-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} className={`aup-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
      <header className="aup-modal-head">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="aup-icon-btn" onClick={onClose} aria-label="Close" data-testid="button-aup-modal-close"><X size={16} /></button>
      </header>
      <div className="aup-modal-body">{children}</div>
      {footer && <footer className="aup-modal-foot">{footer}</footer>}
    </div>
  </div>;
}
