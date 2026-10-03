import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectUpload, MAX_INFLATED_BYTES } from "./uploadSafety";

const pdfWithStream = (content: Buffer) => Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj << /Filter /FlateDecode >>\nstream\n"), deflateSync(content), Buffer.from("\nendstream\nendobj\n")]);

describe("inspectUpload", () => {
  it("accepts plain PDFs and pictures", () => {
    expect(inspectUpload(pdfWithStream(Buffer.from("BT /F1 12 Tf (Hello) Tj ET")), "application/pdf")).toEqual({ ok: true });
    expect(inspectUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]), "image/jpeg")).toEqual({ ok: true });
  });

  it("refuses a compressed stream that unpacks past the cap instead of unpacking it all", () => {
    const bomb = pdfWithStream(Buffer.alloc(MAX_INFLATED_BYTES + 1024));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const result = inspectUpload(bomb, "application/pdf");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too complex/);
  });

  it("finds actions hidden in compressed streams and in #-escaped names", () => {
    expect(inspectUpload(pdfWithStream(Buffer.from("<< /S /Launch /F (cmd.exe) >>")), "application/pdf").ok).toBe(false);
    expect(inspectUpload(Buffer.from("%PDF-1.7\n<< /S /SubmitForm >>"), "application/pdf").ok).toBe(false);
    expect(inspectUpload(Buffer.from("%PDF-1.7\n<< /#4AS (x) >>"), "application/pdf").ok).toBe(false);
    expect(inspectUpload(Buffer.from("%PDF-1.7\n<< /URI (javascript:alert(1)) >>"), "application/pdf").ok).toBe(false);
  });
});
