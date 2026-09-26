import { sql } from "drizzle-orm";
import { db, signInDevicesTable } from "@workspace/db";
import { writeEffects } from "./activity.db";
import type { SignInRepo } from "./signIns";

/** Known devices in Postgres; the sign-in and its notification or email are stored together. */
export const dbSignInRepo: SignInRepo = {
  record: (userId, deviceHash, label, now, effects) => db.transaction(async tx => {
    // xmax is 0 only for a freshly inserted row, so this tells a new device from a known one in one statement.
    const [row] = await tx.insert(signInDevicesTable).values({ userId, deviceHash, label, firstSeen: now, lastSeen: now })
      .onConflictDoUpdate({ target: [signInDevicesTable.userId, signInDevicesTable.deviceHash], set: { lastSeen: now, label } })
      .returning({ isNew: sql<boolean>`(xmax = 0)` });
    const isNew = !!row?.isNew;
    await writeEffects(tx, effects(isNew));
    return isNew;
  }),
};
