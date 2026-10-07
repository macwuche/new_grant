import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskFileStore, minFreeDiskBytes, newStorageKey, StorageFullError } from "./fileStore";

const MB = 1024 * 1024;
const OWNER = "11111111-1111-4111-8111-111111111111";

describe("disk file store: free-space floor", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "files-")); });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("writes while the file leaves the floor free, and refuses (writing nothing) once it wouldn't", async () => {
    let free = 10 * MB;
    const store = diskFileStore(root, { minFreeBytes: 8 * MB, freeBytes: async () => free });
    const ok = newStorageKey(OWNER);
    await store.put(ok, Buffer.alloc(2 * MB));
    expect(await store.get(ok)).toHaveLength(2 * MB);

    free = 9 * MB;
    const refused = newStorageKey(OWNER);
    const err = await store.put(refused, Buffer.alloc(2 * MB)).catch(e => e);
    expect(err).toBeInstanceOf(StorageFullError);
    expect(err).toMatchObject({ freeBytes: 9 * MB, minFreeBytes: 8 * MB });
    expect(await readdir(path.join(root, OWNER))).toEqual([ok.split("/")[1]]);
  });

  it("measures the real disk by default, and writes anyway if the space can't be measured", async () => {
    const real = diskFileStore(root, { minFreeBytes: 1 });
    await real.put(newStorageKey(OWNER), Buffer.from("x"));
    const unmeasurable = diskFileStore(root, { minFreeBytes: 8 * MB, freeBytes: async () => { throw new Error("statfs failed"); } });
    await unmeasurable.put(newStorageKey(OWNER), Buffer.from("x"));
    const off = diskFileStore(root, { minFreeBytes: 0, freeBytes: async () => 0 });
    await off.put(newStorageKey(OWNER), Buffer.from("x"));
    expect(await readdir(path.join(root, OWNER))).toHaveLength(3);
  });

  it("reads the floor from MIN_FREE_DISK_MB: 2,048 MB by default or when invalid, 0 turns it off", () => {
    expect(minFreeDiskBytes({})).toBe(2048 * MB);
    expect(minFreeDiskBytes({ MIN_FREE_DISK_MB: "" })).toBe(2048 * MB);
    expect(minFreeDiskBytes({ MIN_FREE_DISK_MB: "lots" })).toBe(2048 * MB);
    expect(minFreeDiskBytes({ MIN_FREE_DISK_MB: "-5" })).toBe(2048 * MB);
    expect(minFreeDiskBytes({ MIN_FREE_DISK_MB: " 512 " })).toBe(512 * MB);
    expect(minFreeDiskBytes({ MIN_FREE_DISK_MB: "0" })).toBe(0);
  });
});
