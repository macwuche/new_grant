import type { NextFunction, Request, Response } from "express";
import { authLocals } from "./auth";

// Baseline protections for every API response: security headers, and rate
// limits per signed-in user (or per client address before sign-in).

/** Headers for JSON API responses: nothing is cached, framed, sniffed, or sent a referrer. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.removeHeader("X-Powered-By");
  next();
}

export type Limit = { name: string; max: number; windowMs: number };

/**
 * A fixed-window counter held in this process's memory. Enough for one API
 * server; several instances behind a load balancer would each count
 * separately (use a shared store such as Postgres or Redis then).
 */
export function rateLimiter(limit: Limit, key: (req: Request, res: Response) => string, now = () => Date.now()) {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    if (t - lastSweep > limit.windowMs) {
      for (const [k, w] of windows) if (t - w.start >= limit.windowMs) windows.delete(k);
      lastSweep = t;
    }
    const k = key(req, res);
    let w = windows.get(k);
    if (!w || t - w.start >= limit.windowMs) { w = { start: t, count: 0 }; windows.set(k, w); }
    w.count++;
    const reset = Math.ceil((w.start + limit.windowMs - t) / 1000);
    res.set({ "RateLimit-Limit": String(limit.max), "RateLimit-Remaining": String(Math.max(0, limit.max - w.count)), "RateLimit-Reset": String(reset) });
    if (w.count > limit.max) {
      res.set("Retry-After", String(reset));
      req.log?.warn({ limit: limit.name, key: k }, "rate limited");
      res.status(429).json({ error: `Too many requests. Try again in ${reset} second${reset === 1 ? "" : "s"}.` });
      return;
    }
    next();
  };
}

/**
 * Limits failed sign-in checks (401s) per client address, so tokens can't be
 * guessed quickly. Successful requests don't count, so many people behind one
 * address (an office) aren't limited together.
 */
export function failureLimiter(limit: Limit, now = () => Date.now()) {
  const windows = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const t = now();
    const k = byIp(req);
    let w = windows.get(k);
    if (!w || t - w.start >= limit.windowMs) { w = { start: t, count: 0 }; windows.set(k, w); }
    if (w.count >= limit.max) {
      const reset = Math.ceil((w.start + limit.windowMs - t) / 1000);
      res.set("Retry-After", String(reset));
      req.log?.warn({ limit: limit.name, key: k }, "rate limited");
      res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${reset} second${reset === 1 ? "" : "s"}.` });
      return;
    }
    const window = w;
    res.on("finish", () => { if (res.statusCode === 401) window.count++; });
    if (windows.size > 10_000) for (const [key, v] of windows) if (t - v.start >= limit.windowMs) windows.delete(key);
    next();
  };
}

/** The signed-in user, or the client address before authentication. */
export const byUser = (req: Request, res: Response) => authLocals(res).user?.id ?? `ip:${req.ip}`;
export const byIp = (req: Request) => `ip:${req.ip}`;

export const LIMITS = {
  /** Failed token checks (401), per address. */
  anonymous: { name: "anonymous", max: 30, windowMs: 10 * 60_000 },
  /** Every signed-in request, per user. */
  user: { name: "user", max: 300, windowMs: 60_000 },
  /** Any change (POST, PUT, PATCH, DELETE), per user. */
  writes: { name: "writes", max: 60, windowMs: 60_000 },
  /** Document uploads, per user. */
  uploads: { name: "uploads", max: 30, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;
