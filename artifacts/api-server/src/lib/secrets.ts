import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Encryption for secrets saved from the admin settings (API keys, signing
// secrets). AES-256-GCM with a 32-byte key that never leaves the API server:
// SETTINGS_ENCRYPTION_KEY (base64), or a key file generated on first use at
// SETTINGS_KEY_FILE (default data/settings.key, mode 0600). Back that file up
// with the database: without it, saved secrets can't be read and must be
// entered again.

export type Cipher = { encrypt(plain: string): string; decrypt(sealed: string): string };

export function cipherFromKey(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error("The settings encryption key must be 32 bytes.");
  return {
    encrypt: plain => {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
    },
    decrypt: sealed => {
      const [v, iv, tag, body] = sealed.split(":");
      if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("Unknown secret format.");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
    },
  };
}

/** The server's cipher: from SETTINGS_ENCRYPTION_KEY, or the key file (created if missing). */
export function serverCipher(env: NodeJS.ProcessEnv = process.env): Cipher {
  const fromEnv = env["SETTINGS_ENCRYPTION_KEY"]?.trim();
  if (fromEnv) return cipherFromKey(Buffer.from(fromEnv, "base64"));
  const file = path.resolve(env["SETTINGS_KEY_FILE"] || "data/settings.key");
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  }
  chmodSync(file, 0o600);
  return cipherFromKey(Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
}
