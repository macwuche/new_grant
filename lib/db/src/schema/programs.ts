import { sql } from "drizzle-orm";
import { boolean, date, jsonb, numeric, pgEnum, pgSequence, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Grant programs. Mirrors the `Grant` type in @workspace/domain; the rules in
// @workspace/domain/programs decide every change, the API only stores results.
// `updated_at` is the record version: writes succeed only if it's unchanged.
// Row-level security is on with no policies (see ./staff.ts).

export const programStatusEnum = pgEnum("program_status", ["Draft", "Open", "Closed"]);

export type ProgramQuestionJson = { id: string; label: string; type: "text" | "number" | "yesno"; required: boolean };
export type ProgramChangeJson = { at: string; by: string; summary: string };

const money = (name: string) => numeric(name, { precision: 12, scale: 2, mode: "number" }).notNull();

export const programsTable = pgTable("programs", {
  id: text("id").primaryKey(),
  status: programStatusEnum("status").notNull(),
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  focus: text("focus").notNull(),
  maxFunding: money("max_funding"),
  minimumRequest: money("minimum_request"),
  budget: money("budget"),
  deadline: date("deadline", { mode: "string" }).notNull(),
  minimumTier: smallint("minimum_tier").notNull(),
  requirements: jsonb("requirements").$type<string[]>().notNull(),
  requiresRegistration: boolean("requires_registration").notNull(),
  questions: jsonb("questions").$type<ProgramQuestionJson[]>().notNull(),
  changeLog: jsonb("change_log").$type<ProgramChangeJson[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, t => [uniqueIndex("programs_name_unique").on(sql`lower(${t.name})`)]).enableRLS();

export type ProgramRow = typeof programsTable.$inferSelect;
export type InsertProgramRow = typeof programsTable.$inferInsert;

/** Numbers for new program ids (PRG-3001, …); above the browser demo's range. */
export const programNumberSeq = pgSequence("program_number_seq", { startWith: 3001 });
