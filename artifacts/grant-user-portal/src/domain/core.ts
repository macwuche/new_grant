import type { DemoState, Result } from './model';

// Small helpers shared by every rule module (kept dependency-free to avoid import cycles).

export const roundCents = (value: number) => Math.round(value * 100) / 100;

export const fail = (error: string, fieldErrors?: Record<string, string>): Result => ({ ok: false, error, fieldErrors });

/** One counter feeds every generated id, so ids never collide across record types. */
export function nextIds(state: DemoState) {
  const n = state.nextId;
  return { app: `APP-${n}`, tx: `TX-${80000 + n}`, notification: `NT-${n}`, program: `PRG-${n}`, feed: `FD-${n}`, reference: `ARC-${n}`, audit: `AU-${n}`, nextId: n + 1 };
}

export const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
