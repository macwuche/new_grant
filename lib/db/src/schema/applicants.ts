import { boolean, jsonb, pgEnum, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

// One profile per applicant account, keyed by their Supabase Auth user id.
// Created on first use from the details given at sign-up. The email comes
// from the sign-in account. Tier, identity status, the lock, and required
// credential resets are staff-controlled (rules: @workspace/domain/accounts).
// `updated_at` is the record version: writes succeed only if it's unchanged.
// Row-level security is on with no policies (see ./staff.ts).

/** Mirrors `CardsState` in @workspace/domain (model.ts). */
type CardFreezeJson = { frozenBy?: "applicant" | "staff"; frozenReason?: string };
type ShippingAddressJson = { name: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string };
export type CardsJson = {
  virtual: ({ lastFour: string; dailyLimit: number; frozen: boolean; pin: string; createdAt?: string; createdBy?: string } & CardFreezeJson) | null;
  physical: {
    status: "Not requested" | "Requested" | "Shipped" | "Active" | "Declined" | "Cancelled"; dailyLimit: number;
    lastFour?: string; frozen?: boolean; shippingAddress?: ShippingAddressJson; requestedAt?: string; feeTxId?: string; issuedBy?: string;
    shippedAt?: string; shippedBy?: string; trackingRef?: string; shippingMessage?: string; activatedAt?: string;
    declinedAt?: string; declinedBy?: string; declineReason?: string;
    cancelledAt?: string; cancelledBy?: string; cancelReason?: string;
  } & CardFreezeJson;
};

/** Mirrors `AccountPermissions` in @workspace/domain, without `emailNotifications` (its own column). */
export type AccountPermissionsJson = { payoutKyc: boolean; depositKyc: boolean; cardApplications: boolean; grantApplications: boolean };

export const accountStatusEnum = pgEnum("account_status", ["Active", "Locked"]);

/** Identity check; only the last four characters of the document number are kept. Mirrors `Kyc` in @workspace/domain. */
export type KycJson = {
  status: "Not submitted" | "Pending" | "Verified" | "Rejected";
  documentType?: "Passport" | "National ID" | "Driver's licence";
  documentLast4?: string;
  nameOnDocument?: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
};

export const applicantProfilesTable = pgTable("applicant_profiles", {
  authUserId: uuid("auth_user_id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  sector: text("sector").notNull().default(""),
  country: text("country").notNull().default(""),
  birthDate: text("birth_date"),
  tier: smallint("tier").notNull().default(1),
  identityVerified: boolean("identity_verified").notNull().default(false),
  accountStatus: accountStatusEnum("account_status").notNull().default("Active"),
  lockReason: text("lock_reason"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  passwordResetRequired: boolean("password_reset_required").notNull().default(false),
  twoFactorResetRequired: boolean("two_factor_reset_required").notNull().default(false),
  /** When staff required each reset; completing it needs proof from after this time. */
  passwordResetRequiredAt: timestamp("password_reset_required_at", { withTimezone: true }),
  twoFactorResetRequiredAt: timestamp("two_factor_reset_required_at", { withTimezone: true }),
  kyc: jsonb("kyc").$type<KycJson>().notNull().default({ status: "Not submitted" }),
  /** Staff card rules: which balances the applicant may fund their card from, and whether cards need a verified identity. */
  cardFunding: text("card_funding").$type<"deposit" | "grant" | "both">().notNull().default("deposit"),
  cardKycRequired: boolean("card_kyc_required").notNull().default(false),
  /** Staff permission switches (identity checks for payouts and deposits, card and grant applications); null means the defaults. Email copies live in `email_notifications`. */
  permissions: jsonb("permissions").$type<AccountPermissionsJson | null>(),
  /** Virtual and physical card settings (fictional: no card provider is connected). */
  cards: jsonb("cards").$type<CardsJson | null>(),
  /**
   * The applicant's last payout form answers per withdrawal method (method id → field id → value), used to
   * pre-fill the next request. Full values: finance needs them to pay. Rows from before 29 Sep 2026 hold masked
   * labels (method id → string) instead; the API ignores those.
   */
  payoutDestinations: jsonb("payout_destinations").$type<Record<string, Record<string, string> | string>>().notNull().default({}),
  destinationChangedAt: timestamp("destination_changed_at", { withTimezone: true }),
  /** Whether in-app notifications are also sent by email. */
  emailNotifications: boolean("email_notifications").notNull().default(true),
  /** Profile center (the applicant's own edits): the @handle, and a Telegram username without the "@". */
  displayName: text("display_name").notNull().default(""),
  telegram: text("telegram").notNull().default(""),
  /** Privacy switches: keep device, IP, and location with security events; email an alert for a new device. */
  activityLoggingEnabled: boolean("activity_logging_enabled").notNull().default(true),
  unusualActivityEmailEnabled: boolean("unusual_activity_email_enabled").notNull().default(true),
  /** Profile photo: a file on the API server's disk (FileStore key), its detected type, and SHA-256 (checked on every read). */
  avatarKey: text("avatar_key"),
  avatarType: text("avatar_type"),
  avatarSha256: text("avatar_sha256"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export type ApplicantProfileRow = typeof applicantProfilesTable.$inferSelect;
