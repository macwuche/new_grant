import { createHash, randomUUID } from "node:crypto";
import { cleanFileName, detectType } from "../routes/documents";
import { detectImage } from "../routes/profile";
import { rebuildImage } from "./imageRebuild";
import type { FileStore } from "./fileStore";
import type { InboxAttachment, InboxMessage } from "./inbox";
import { logger } from "./logger";
import { downloadFile, resendApi, type Fetch } from "./providers";
import { inspectUpload } from "./uploadSafety";

// Files staff attach to mail written in the team inbox (owner, 17 Oct 2026:
// staff may attach files, checked like every other upload; no virus scanner
// yet). PDF, JPEG, PNG, WEBP, plain text, and CSV; at most 10 files and 10 MB
// in all. Pictures are rebuilt from their pixels; PDFs and other files go
// through the hidden-content checks. Office files are refused: they are zip
// archives, which the checks reject. The checked files are kept on the API
// server's disk (so the Sent copy and drafts can open them) and sent to Resend.
// Forwarded files (from received mail or our own) go through the same checks.

export const MAX_INBOX_ATTACHMENTS = 10;
export const MAX_INBOX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The send request's JSON limit: 10 MB of files as base64 (×4/3) plus the message. */
export const INBOX_SEND_JSON_LIMIT = "15mb";
/** Storage owner for inbox attachments: the team mailbox, not a person (keys are `<owner uuid>/<uuid>`). */
export const INBOX_FILES_OWNER = "00000000-0000-4000-8000-00000000ba11";

export type CheckedAttachment = { id: string; filename: string; contentType: string; size: number; sha256: string; bytes: Buffer };

const TEXT_TYPES: Record<string, string> = { txt: "text/plain", csv: "text/csv" };
const TYPES_HINT = "Attach PDF, JPG, PNG, WEBP, TXT, or CSV files.";

/** Text files: valid UTF-8 with no control characters other than tab and line breaks. */
function isPlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return false; }
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function typeOf(filename: string, bytes: Buffer): string | null {
  const binary = detectType(bytes) ?? detectImage(bytes);
  if (binary) return binary;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  return TEXT_TYPES[ext] && isPlainText(bytes) ? TEXT_TYPES[ext]! : null;
}

/** The base64 content as bytes; null if it isn't base64. */
function decode(content: unknown): Buffer | null {
  if (typeof content !== "string" || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(content)) return null;
  return Buffer.from(content, "base64");
}

/** A file from another message (forwarded, or kept from a draft), already read. */
export type AttachmentSource = { filename: string; bytes: Buffer };

/**
 * Checks the files of a message being sent or saved: `input` is the newly
 * attached `[{ filename, content (base64) }]`; `sources` are files carried from
 * other messages (checked the same way); `kept` are a draft's own files, already
 * checked and stored, which count toward the limits. Returns the files to store
 * and send (sources first, then new files, in order), or the reason to refuse.
 */
export async function checkInboxAttachments(input: unknown, extra: { sources?: AttachmentSource[]; kept?: { size: number | null }[] } = {}): Promise<{ ok: true; files: CheckedAttachment[] } | { ok: false; error: string }> {
  const sources = extra.sources ?? [], kept = extra.kept ?? [];
  if (input !== undefined && input !== null && !Array.isArray(input)) return { ok: false, error: "Attachments couldn't be read. Attach the files again." };
  const items = (input ?? []) as { filename?: unknown; content?: unknown }[];
  if (kept.length + sources.length + items.length > MAX_INBOX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_INBOX_ATTACHMENTS} files.` };
  const all: AttachmentSource[] = [...sources];
  for (const item of items) {
    const filename = cleanFileName(typeof item?.filename === "string" ? item.filename : undefined);
    const raw = decode(item?.content);
    if (!raw) return { ok: false, error: `${filename} couldn't be read. Attach it again.` };
    all.push({ filename, bytes: raw });
  }
  const files: CheckedAttachment[] = [];
  let total = kept.reduce((n, f) => n + (f.size ?? 0), 0);
  for (const { filename: name, bytes: raw } of all) {
    const filename = cleanFileName(name);
    if (!raw.length) return { ok: false, error: `${filename} is empty.` };
    total += raw.length;
    if (total > MAX_INBOX_ATTACHMENT_BYTES) return { ok: false, error: "Attachments can be up to 10 MB in all." };
    const contentType = typeOf(filename, raw);
    if (!contentType) return { ok: false, error: `${filename} isn't a file type you can attach. ${TYPES_HINT}` };
    const unsafe = inspectUpload(raw, contentType);
    if (!unsafe.ok) return { ok: false, error: `${filename}: ${unsafe.reason}` };
    const rebuilt = await rebuildImage(raw, contentType);
    if (!rebuilt.ok) return { ok: false, error: `${filename}: ${rebuilt.reason}` };
    const bytes = rebuilt.bytes;
    files.push({ id: randomUUID(), filename, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
  }
  return { ok: true, files };
}

/** Received attachments are fetched from Resend up to this size (Resend accepts mail up to 40 MB). */
export const MAX_RECEIVED_ATTACHMENT_BYTES = 40 * 1024 * 1024;

export type LoadedAttachment = { ok: true; bytes: Buffer } | { ok: false; status: number; error: string };

/**
 * A message's attachment as bytes: files attached here come from the disk
 * (checked against their SHA-256); received ones from Resend, through the
 * signed link it gives for each (fetched now, never stored).
 */
export async function loadInboxAttachment(message: InboxMessage, att: InboxAttachment, deps: { files?: FileStore; resendKey: string | null | undefined; fetchImpl: Fetch }): Promise<LoadedAttachment> {
  if (att.key) {
    const bytes = deps.files ? await deps.files.get(att.key) : null;
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== att.sha256) {
      logger.error({ message: message.id, attachment: att.id, missing: !bytes }, "inbox attachment is missing or doesn't match its record");
      return { ok: false, status: 500, error: `${att.filename} can't be opened: the stored file is missing or has changed.` };
    }
    return { ok: true, bytes };
  }
  if (message.direction !== "inbound" || !message.resendId) return { ok: false, status: 404, error: `${att.filename} isn't stored anywhere we can reach.` };
  if (!deps.resendKey) return { ok: false, status: 503, error: "Received attachments come from Resend: a super admin needs to add the Resend key under Settings → Email." };
  const resend = resendApi(deps.resendKey, deps.fetchImpl);
  const link = await resend.getReceivedAttachment(message.resendId, att.id);
  if (!link.ok) { logger.warn({ message: message.id, attachment: att.id, error: link.error }, "couldn't get a received attachment's link"); return { ok: false, status: 502, error: `Resend couldn't give us ${att.filename}. Try again in a moment.` }; }
  const file = await downloadFile(deps.fetchImpl, link.data.download_url, MAX_RECEIVED_ATTACHMENT_BYTES, "Resend");
  if (!file.ok) { logger.warn({ message: message.id, attachment: att.id, error: file.error }, "couldn't download a received attachment"); return { ok: false, status: 502, error: file.status === 413 ? `${att.filename} is larger than 40 MB.` : `Couldn't download ${att.filename} from Resend. Try again in a moment.` }; }
  return { ok: true, bytes: file.data };
}
