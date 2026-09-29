import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Devices each account has signed in from, to tell a new device from a known one.
 * `deviceHash` is a SHA-256 of the account id and a random id the browser keeps;
 * the raw id is never stored.
 */
export const signInDevicesTable = pgTable("sign_in_devices", {
  userId: text("user_id").notNull(),
  deviceHash: text("device_hash").notNull(),
  /** Browser and operating system, e.g. "Chrome on Windows". */
  label: text("label").notNull(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.deviceHash] })]).enableRLS();

export type SignInDeviceRow = typeof signInDevicesTable.$inferSelect;

/**
 * Each account's security activity (sign-ins, password and email changes,
 * failed password checks, two-step changes, signing out other devices), shown
 * on the applicant's profile. Device, IP address, and location are kept only
 * while the account's "save my activity logs" switch is on.
 */
export const securityEventsTable = pgTable("security_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  device: text("device"),
  ip: text("ip"),
  location: text("location"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("security_events_user_idx").on(t.userId, t.at)]).enableRLS();

export type SecurityEventRow = typeof securityEventsTable.$inferSelect;
