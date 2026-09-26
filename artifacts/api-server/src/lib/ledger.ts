import type { Transaction } from "@workspace/domain/model";

// Stores what a rule changed in the ledger. Money routes give the rules a block
// of ten fresh numbers (nextId), so new entries already have unique ids. Other
// routes (approvals credit awards, submissions charge fees) run rules whose
// counter serves another purpose, so their new entries are renumbered here.

export async function storeLedgerChanges(
  before: Transaction[], after: Transaction[], save: (tx: Transaction) => Promise<void>, renumber?: () => Promise<number>,
): Promise<Transaction[]> {
  const previous = new Map(before.map(t => [t.id, JSON.stringify(t)]));
  const added = after.filter(t => !previous.has(t.id));
  const changed = after.filter(t => previous.has(t.id) && previous.get(t.id) !== JSON.stringify(t));
  if (added.length > 10) throw new Error("a rule created more ledger entries than one id block holds");
  const block = renumber && added.length ? await renumber() : null;
  const stored = added.map((t, i) => block === null ? t : { ...t, id: `TX-${80000 + block + i}` });
  for (const t of [...stored, ...changed]) await save(t);
  return stored;
}
