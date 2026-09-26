import { createApp } from "./app";
import { supabaseVerifier } from "./lib/auth";
import { logger } from "./lib/logger";
import { ensureInitialSuperAdmin } from "./lib/staffRepo";
import { dbStaffRepo } from "./lib/staffRepo.db";
import { ensureSeedPrograms } from "./lib/programRepo";
import { dbProgramRepo } from "./lib/programRepo.db";
import { dbProfileRepo } from "./lib/profileRepo.db";
import { dbApplicationRepo } from "./lib/applicationRepo.db";
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

const seeded = await ensureSeedPrograms(dbProgramRepo, seedGrants());
if (seeded) logger.info({ count: seeded }, "sample grant programs added to the empty programs table");

const app = createApp({
  verifier: supabaseUrl && supabaseAnonKey ? supabaseVerifier(supabaseUrl, supabaseAnonKey) : null,
  staffRepo: dbStaffRepo, programRepo: dbProgramRepo, profileRepo: dbProfileRepo, applicationRepo: dbApplicationRepo,
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
