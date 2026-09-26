import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { apiRouter, type ApiDeps } from "./routes";
import { logger } from "./lib/logger";

/** Origins allowed to call the API from a browser: CORS_ORIGINS plus the Replit domains. Same-host requests are always allowed. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env["CORS_ORIGINS"] ?? "").split(",").map(o => o.trim()).filter(Boolean);
  for (const domain of [env["REPLIT_DEV_DOMAIN"], ...(env["REPLIT_DOMAINS"] ?? "").split(",")]) {
    if (domain?.trim()) list.push(`https://${domain.trim()}`);
  }
  return list;
}

export function createApp(deps: ApiDeps, origins: string[] = allowedOrigins()): Express {
  const app: Express = express();
  // The client address comes from the proxy in front of the app (Replit's): trust that many hops, no more,
  // so a client can't choose the IP recorded in the audit log.
  app.set("trust proxy", Number(process.env["TRUST_PROXY_HOPS"] ?? 1));

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(
    cors((req, callback) => {
      const origin = req.headers.origin;
      const sameHost = !!origin && (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      callback(null, { origin: !origin || sameHost || origins.includes(origin) });
    }),
  );
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", apiRouter(deps));

  // Unexpected errors: log them, and never leak details to the client.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err }, "unhandled error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
