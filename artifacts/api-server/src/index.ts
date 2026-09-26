import { createApp } from "./app";
import { supabaseVerifier } from "./lib/auth";
import { logger } from "./lib/logger";
import { ensureInitialSuperAdmin } from "./lib/staffRepo";
import { dbStaffRepo } from "./lib/staffRepo.db";
import { ensureSeedPrograms } from "./lib/programRepo";
import { dbProgramRepo } from "./lib/programRepo.db";
import { dbProfileRepo } from "./lib/profileRepo.db";
import { dbApplicationRepo } from "./lib/applicationRepo.db";
import { dbActivityRepo } from "./lib/activity.db";
import { dbMoneyRepo, ensureSettings } from "./lib/moneyRepo.db";
import { dbDocumentRepo } from "./lib/documentRepo.db";
import { diskFileStore, documentsDir } from "./lib/fileStore";
import { appUrl, mailerFromEnv, startEmailWorker } from "./lib/email";
import { dbEmailOutbox } from "./lib/emailOutbox.db";
import { seedGrants } from "@workspace/domain/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseAnonKey = process.env["SUPABASE_ANON_KEY"];
if (!supabaseUrl || !supabaseAnonKey) logger.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set: signed-in API routes will answer 503");

const initialEmail = process.env["INITIAL_SUPER_ADMIN_EMAIL"];
if (initialEmail) {
  const created = await ensureInitialSuperAdmin(dbStaffRepo, initialEmail, process.env["INITIAL_SUPER_ADMIN_NAME"] ?? "Super admin");
  if (created) logger.info({ email: created.email }, "initial super admin created");
}

if (await ensureSettings()) logger.info("default money settings created");
const seeded = await ensureSeedPrograms(dbProgramRepo, seedGrants());
if (seeded) logger.info({ count: seeded }, "sample grant programs added to the empty programs table");

const docsDir = documentsDir();
logger.info({ dir: docsDir }, "document files are stored on this server's disk");

const mailer = mailerFromEnv();
if (mailer.configured) logger.info({ from: mailer.from, links: appUrl() }, "email is sent through Resend");
else logger.warn("RESEND_API_KEY / EMAIL_FROM not set: email is off (queued messages are marked skipped)");
if (mailer.configured && !appUrl()) logger.warn("APP_URL not set: emails won't include links to the portal");
startEmailWorker(dbEmailOutbox, mailer);

const app = createApp({
  verifier: supabaseUrl && supabaseAnonKey ? supabaseVerifier(supabaseUrl, supabaseAnonKey) : null,
  staffRepo: dbStaffRepo, programRepo: dbProgramRepo, profileRepo: dbProfileRepo, applicationRepo: dbApplicationRepo, activityRepo: dbActivityRepo, moneyRepo: dbMoneyRepo,
  documentRepo: dbDocumentRepo, fileStore: diskFileStore(docsDir), emailOutbox: dbEmailOutbox, mailer,
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
