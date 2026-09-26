import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
