import type { ErrorRequestHandler } from "express";
import type { DocumentRepo } from "./documentRepo";
import { StorageFullError } from "./fileStore";
import { logger } from "./logger";
import type { MoneyRepo } from "./moneyRepo";

// Disk protections for uploads (7 Oct 2026). Files live on the API server's
// disk, so two limits keep one account, or the server as a whole, from
// filling it:
//
// - each applicant keeps at most MAX_ACCOUNT_FILE_BYTES of application and
//   identity documents plus deposit receipts (receipts of cancelled or
//   rejected deposits included: their files stay on disk);
// - the file store refuses writes below the free-space floor
//   (MIN_FREE_DISK_MB, ./fileStore.ts); every upload route then answers 507
//   and staff get an alert in the team activity feed.

export const MAX_ACCOUNT_FILE_BYTES = 200 * 1024 * 1024;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Bytes of the applicant's files on the server: live documents and every deposit receipt. */
export async function accountFileBytes(ownerId: string, documents: Pick<DocumentRepo, "listForOwner">, money: Pick<MoneyRepo, "ledgerFor">): Promise<number> {
  const [docs, ledger] = await Promise.all([documents.listForOwner(ownerId), money.ledgerFor(ownerId)]);
  return docs.reduce((sum, d) => sum + d.sizeBytes, 0)
    + ledger.reduce((sum, t) => sum + (t.proof ?? []).reduce((n, p) => n + p.sizeBytes, 0), 0);
}

/** Why a new file of `incoming` bytes would put the account over its total, or null. */
export async function accountFileLimit(ownerId: string, incoming: number, documents: Pick<DocumentRepo, "listForOwner">, money: Pick<MoneyRepo, "ledgerFor">): Promise<string | null> {
  const used = await accountFileBytes(ownerId, documents, money);
  if (used + incoming <= MAX_ACCOUNT_FILE_BYTES) return null;
  return `Your account can keep up to ${MAX_ACCOUNT_FILE_BYTES / 1024 / 1024} MB of files and ${mb(used)} is used. Remove files you no longer need from a draft application or a pending deposit, or contact support.`;
}

export const STORAGE_FULL_MESSAGE = "Uploads are paused because the server is low on storage. Try again later.";
const ALERT_EVERY_MS = 60 * 60_000;

/**
 * Answers 507 for uploads refused at the free-space floor, and tells staff:
 * a highlighted security item in the team activity feed, at most once an hour
 * per API process. Other errors pass through.
 */
export function storageFullHandler(documents: Pick<DocumentRepo, "record">, now: () => number = Date.now): ErrorRequestHandler {
  let lastAlert = -Infinity;
  return async (err, _req, res, next) => {
    if (!(err instanceof StorageFullError)) { next(err); return; }
    logger.error({ freeBytes: err.freeBytes, minFreeBytes: err.minFreeBytes }, "upload refused: the server is low on storage");
    res.status(507).json({ error: STORAGE_FULL_MESSAGE });
    if (now() - lastAlert < ALERT_EVERY_MS) return;
    lastAlert = now();
    await documents.record({
      notifications: [], audit: [],
      staffEvents: [{
        at: new Date(now()).toISOString(), kind: "security", highlight: true, href: "/admin",
        title: "Server storage is low: uploads are paused",
        body: `${mb(err.freeBytes)} free on the documents disk; uploads stop below ${mb(err.minFreeBytes)}. Free up space or add disk on the server (see server.md, "Disk space").`,
      }],
    }).catch(alertErr => logger.error({ err: alertErr }, "couldn't record the low-storage alert"));
  };
}
