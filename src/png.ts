/**
 * Minimal PNG reader + visual sanity analysis.
 *
 * Dependency-free: Node's zlib does the IDAT inflate. Chrome screenshots are
 * 8-bit non-interlaced RGB or RGBA, which is what this handles.
 */

import { inflateSync } from "node:zlib";
import type { VisualReport } from "./types.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface DecodedImage {
  width: number;
  height: number;
  /** RGB triplets, one per pixel. */
  pixels: Uint8Array;
}

function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // gray
    case 2: return 3; // rgb
    case 3: return 1; // palette
    case 4: return 2; // gray + alpha
    case 6: return 4; // rgba
    default: return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer: Buffer): DecodedImage {
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error("Not a PNG file");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + 4;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!width || !height) throw new Error("PNG missing IHDR");
  if (interlace !== 0) throw new Error("Interlaced PNG not supported");
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = bytesPerPixel(colorType);
  if (bpp === 0) throw new Error(`Unsupported color type ${colorType}`);
  const stride = width * bpp;

  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0: value = line[x]; break;
        case 1: value = line[x] + a; break;
        case 2: value = line[x] + b; break;
        case 3: value = line[x] + ((a + b) >> 1); break;
        case 4: value = line[x] + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (colorType === 2) {
        r = cur[x * 3]; g = cur[x * 3 + 1]; b = cur[x * 3 + 2];
      } else if (colorType === 6) {
        r = cur[x * 4]; g = cur[x * 4 + 1]; b = cur[x * 4 + 2];
      } else if (colorType === 0) {
        r = g = b = cur[x];
      } else if (colorType === 4) {
        r = g = b = cur[x * 2];
      } else {
        const index = cur[x] * 3;
        r = palette ? palette[index] : 0;
        g = palette ? palette[index + 1] : 0;
        b = palette ? palette[index + 2] : 0;
      }
      out[y * width * 3 + x * 3] = r;
      out[y * width * 3 + x * 3 + 1] = g;
      out[y * width * 3 + x * 3 + 2] = b;
    }
    prev = cur;
  }

  return { width, height, pixels: out };
}

export interface LuminanceStats {
  mean: number;
  stdDev: number;
  blackFraction: number;
  whiteFraction: number;
  uniqueColors: number;
  meanSaturation: number;
}

export function analyzePixels(image: DecodedImage): LuminanceStats {
  const { pixels } = image;
  const count = pixels.length / 3;
  let sum = 0;
  let sumSq = 0;
  let black = 0;
  let white = 0;
  let satSum = 0;
  const seen = new Set<number>();

  for (let i = 0; i < pixels.length; i += 3) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    sumSq += lum * lum;
    if (lum < 12) black++;
    if (lum > 240) white++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    satSum += max === 0 ? 0 : (max - min) / max;
    if (seen.size < 20000) seen.add((r << 16) | (g << 8) | b);
  }

  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;

  return {
    mean,
    stdDev: Math.sqrt(variance),
    blackFraction: count > 0 ? black / count : 1,
    whiteFraction: count > 0 ? white / count : 1,
    uniqueColors: seen.size,
    meanSaturation: count > 0 ? satSum / count : 0,
  };
}

/**
 * Visual sanity gate. A real 3D scene must have contrast, some colour, and
 * must not be a flat black or flat white rectangle.
 */
export function visualSanity(image: DecodedImage): VisualReport {
  const stats = analyzePixels(image);
  const reasons: string[] = [];

  // A genuinely empty render is uniformly black/white. A dark-but-real scene
  // (night garden, shadowed pagoda) is allowed as long as it has structure.
  if (stats.mean < 12 && stats.stdDev < 30) reasons.push(`mean luminance ${stats.mean.toFixed(1)} is near black with no structure`);
  if (stats.mean > 235) reasons.push(`mean luminance ${stats.mean.toFixed(1)} is near white`);
  if (stats.blackFraction > 0.92) reasons.push(`${(stats.blackFraction * 100).toFixed(1)}% of pixels are black`);
  if (stats.whiteFraction > 0.92) reasons.push(`${(stats.whiteFraction * 100).toFixed(1)}% of pixels are white`);
  if (stats.luminanceStdDev < 20) reasons.push(`luminance std dev ${stats.luminanceStdDev.toFixed(1)} is too low (flat image)`);
  if (stats.uniqueColors < 12) reasons.push(`only ${stats.uniqueColors} distinct colours`);
  if (stats.meanSaturation < 0.04) reasons.push(`mean saturation ${stats.meanSaturation.toFixed(3)} is too low (no colour)`);

  return {
    ok: reasons.length === 0,
    width: image.width,
    height: image.height,
    meanLuminance: stats.mean,
    luminanceStdDev: stats.stdDev,
    blackFraction: stats.blackFraction,
    whiteFraction: stats.whiteFraction,
    uniqueColors: stats.uniqueColors,
    meanSaturation: stats.meanSaturation,
    reasons,
  };
}
