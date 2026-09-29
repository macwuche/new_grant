import { useEffect, useState } from 'react';
import { methodInitial } from '@workspace/domain/withdrawalMethods';

/**
 * A withdrawal method's photo, or its first letter when it has none (or the
 * photo can't be loaded, e.g. a broken link). Decorative: the method's name is
 * always shown next to it.
 */
export function MethodBadge({ name, photoUrl, size = 40, className = '', testId }: { name: string; photoUrl: string; size?: number; className?: string; testId?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [photoUrl]);
  const style = { width: size, height: size, flex: `0 0 ${size}px`, borderRadius: Math.round(size * 0.3), fontSize: Math.round(size * 0.42) };
  if (photoUrl && !broken) {
    return <span className={`method-badge has-photo ${className}`} style={style} aria-hidden="true" data-testid={testId} data-kind="photo">
      <img src={photoUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
    </span>;
  }
  return <span className={`method-badge ${className}`} style={style} aria-hidden="true" data-testid={testId} data-kind="initial">{methodInitial(name)}</span>;
}
