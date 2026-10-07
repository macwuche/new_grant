import sharp from "sharp";

// Rebuilds uploaded pictures from their pixels ("content disarm and
// reconstruction", 7 Oct 2026). The type and hidden-content checks
// (./uploadSafety.ts) refuse what they recognise; rebuilding then keeps only
// the image itself, so anything else in the file — code appended after a real
// image header, unusual chunks, and the photo's metadata (GPS location, phone
// model, timestamps) — is never stored. A file that can't be decoded as the
// picture its first bytes claim is refused. PDFs aren't pictures and pass
// through unchanged.

/** Larger pictures are refused (a 48 MP phone photo fits); also bounds memory on the small server. */
export const MAX_IMAGE_PIXELS = 50_000_000;
const TIMEOUT_SECONDS = 15;

// Each upload is decoded once: libvips' operation cache only costs memory here.
sharp.cache(false);

type ImageType = "image/jpeg" | "image/png" | "image/webp";
const FORMAT: Record<ImageType, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };

const unreadable = "This picture couldn't be read. Upload a different photo or a screenshot.";

export type Rebuilt = { ok: true; bytes: Buffer } | { ok: false; reason: string };

const isImage = (contentType: string): contentType is ImageType => contentType in FORMAT;

/** A new file of the same type made from the picture's pixels only; other content types are returned as they are. */
export async function rebuildImage(bytes: Buffer, contentType: string): Promise<Rebuilt> {
  if (!isImage(contentType)) return { ok: true, bytes };
  try {
    // failOn "error": slightly damaged phone photos still open; the output is a fresh file either way.
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error", pages: 1 });
    const meta = await image.metadata();
    // The first bytes said one type; libvips must agree, or this isn't the picture it claims to be.
    if (meta.format !== FORMAT[contentType]) return { ok: false, reason: unreadable };
    // Upright from the EXIF orientation first: the metadata (orientation included) isn't kept.
    const upright = image.rotate().timeout({ seconds: TIMEOUT_SECONDS });
    const out = contentType === "image/jpeg" ? upright.jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      : contentType === "image/png" ? upright.png()
      : upright.webp({ quality: 92 });
    return { ok: true, bytes: await out.toBuffer() };
  } catch (err) {
    if (/pixel limit/i.test(String((err as Error)?.message))) return { ok: false, reason: `This picture is too large (over ${MAX_IMAGE_PIXELS / 1_000_000} megapixels). Resize it or take a screenshot, then upload that.` };
    return { ok: false, reason: unreadable };
  }
}
