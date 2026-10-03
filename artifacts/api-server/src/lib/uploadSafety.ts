import { inflateSync } from "node:zlib";

// Content checks for uploaded files, run after the type is detected from the
// file's first bytes (a renamed file of another type never gets this far).
// They refuse files that carry something other than a document or picture:
//
// - any file with a Windows or Linux program or a zip archive hidden inside it
//   (a "polyglot" that is also a valid archive), and pictures carrying markup
//   or code a browser or server could run (HTML, script, PHP, SVG). PDFs
//   aren't checked for markup: a PDF of a web page or code may quote it as text;
// - PDFs that run JavaScript, launch programs, embed other files, submit or
//   import form data, play rich media, use XFA forms, or are encrypted (an
//   encrypted PDF can't be inspected). Compressed PDF streams are unpacked and
//   checked too, up to a size cap, and #-escaped names (/J#61vaScript) are
//   decoded first.
//
// This isn't a virus scanner: a scanner (e.g. ClamAV on the server) would be
// the next layer. Files are stored privately and served as downloads with a
// sandboxing Content-Security-Policy either way.

/** Unpacked PDF stream bytes we'll inspect before refusing the file as too complex. */
export const MAX_INFLATED_BYTES = 40 * 1024 * 1024;
const MAX_STREAMS = 5000;

const ACTIVE_CONTENT: [RegExp, string][] = [
  [/<script[\s>/]/i, "script"],
  [/<\?php/i, "PHP code"],
  [/<html[\s>]/i, "a web page"],
  [/<iframe[\s>]/i, "a web page"],
  [/<svg[\s>]/i, "an SVG drawing"],
  [/javascript:/i, "script"],
];

/** Signatures that only appear when a program or archive is inside the file. */
const EMBEDDED: [Buffer, string][] = [
  [Buffer.from("This program cannot be run in DOS mode", "latin1"), "a Windows program"],
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]), "a Linux program"],
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01]), "a Linux program"],
];
const ZIP_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** PDF names that make a document do something rather than show something. */
const PDF_ACTIONS: [RegExp, string][] = [
  [/\/JavaScript\b|\/JS[\s/(<[]/, "JavaScript"],
  [/\/Launch\b/, "an action that launches a program"],
  [/\/EmbeddedFiles?\b/, "an embedded file"],
  [/\/SubmitForm\b|\/ImportData\b/, "a form that sends or loads data"],
  [/\/RichMedia\b/, "embedded media"],
  [/\/XFA\b/, "an XFA form"],
  [/\/GoToE\b/, "a link into an embedded file"],
  [/\/URI\s*\(\s*javascript:/i, "a script link"],
];

export type Inspection = { ok: true } | { ok: false; reason: string };

const refuse = (what: string): Inspection => ({ ok: false, reason: `This file can't be accepted: it contains ${what}. Upload a plain PDF, JPEG, or PNG (for example, print it to PDF or take a screenshot).` });

/** Decodes #xx escapes in PDF names so /J#61vaScript reads as /JavaScript. */
const decodeNames = (text: string) => text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function scanText(text: string, pdf: boolean): Inspection {
  if (!pdf) {
    for (const [pattern, what] of ACTIVE_CONTENT) if (pattern.test(text)) return refuse(what);
    return { ok: true };
  }
  const names = decodeNames(text);
  if (/\/Encrypt\b/.test(names)) return { ok: false, reason: "This PDF is password-protected or encrypted, so it can't be checked. Save a copy without a password and upload that." };
  for (const [pattern, what] of PDF_ACTIONS) if (pattern.test(names)) return refuse(what);
  return { ok: true };
}

/** The compressed streams of a PDF, unpacked (streams that aren't zlib data are skipped). */
function* inflatedStreams(bytes: Buffer): Generator<Buffer | "too-large"> {
  let total = 0;
  let from = 0;
  for (let n = 0; ; n++) {
    if (n >= MAX_STREAMS) { yield "too-large"; return; }
    const start = bytes.indexOf("stream", from, "latin1");
    if (start < 0) return;
    let body = start + 6;
    if (bytes[body] === 0x0d) body++;
    if (bytes[body] === 0x0a) body++;
    const end = bytes.indexOf("endstream", body, "latin1");
    if (end < 0) return;
    from = end + 9;
    // Only zlib-compressed (FlateDecode) data starts with a zlib header: 0x78 then a check byte.
    if (bytes[body] !== 0x78) continue;
    try {
      const out = inflateSync(bytes.subarray(body, end), { maxOutputLength: MAX_INFLATED_BYTES - total });
      total += out.length;
      yield out;
    } catch (err) {
      if (err instanceof RangeError || (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") { yield "too-large"; return; }
      // Truncated or not really compressed: nothing more to read from this stream.
    }
    if (total >= MAX_INFLATED_BYTES) { yield "too-large"; return; }
  }
}

/** Checks an upload whose type was already detected from its first bytes. */
export function inspectUpload(bytes: Buffer, contentType: string): Inspection {
  for (const [signature, what] of EMBEDDED) if (bytes.includes(signature)) return refuse(what);
  if (bytes.includes(ZIP_LOCAL) && bytes.includes(ZIP_END)) return refuse("a hidden archive");
  const pdf = contentType === "application/pdf";
  const text = scanText(bytes.toString("latin1"), pdf);
  if (!text.ok) return text;
  if (!pdf) return { ok: true };
  for (const stream of inflatedStreams(bytes)) {
    if (stream === "too-large") return { ok: false, reason: "This PDF is too complex to check. Save it again (for example, print it to PDF) and upload the copy." };
    const inner = scanText(stream.toString("latin1"), true);
    if (!inner.ok) return inner;
  }
  return { ok: true };
}
