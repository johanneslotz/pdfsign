/**
 * Signature extraction from photographs and scans.
 *
 * A photo of a signature can't be thresholded directly: page shadows, colour
 * casts and paper texture mean no single luminance cut-off separates ink from
 * paper. Instead we estimate the local paper brightness ("illumination") and
 * threshold how much darker each pixel is than the paper next to it:
 *
 *   1. warp the user's quad (crop + rotation + perspective) to an upright image
 *   2. estimate paper brightness per channel — downsample, max-filter, blur
 *   3. ink = 1 - min over RGB of (pixel / paper), so coloured ink scores as
 *      strongly as black (a blue pen darkens the red channel almost fully)
 *   4. Otsu on that ink map gives the auto threshold
 *   5. connected-component filtering drops speckles (paper grain, dust)
 *   6. a soft band around the threshold gives anti-aliased stroke edges
 */

const SMALL_TARGET = 88;   // long edge of the downsampled illumination estimate
const MAX_FILTER_R = 3;    // dilation radius on the small image
const BLUR_R       = 2;    // smoothing radius on the small image
const EDGE_BAND    = 0.06; // half-width of the soft threshold ramp
const ALPHA_FLOOR  = 8;    // alpha below this counts as empty when trimming

export const DEFAULT_PARAMS = {
  threshold: null,   // null → Otsu on the ink map
  despeckle: 25,     // 0..100 slider
  inkColor:  null,   // null → sampled from the image
  trim:      true,
};

// ── Source loading ───────────────────────────────────────────────────────────

/**
 * Decode a file into a canvas, honouring EXIF orientation and flattening any
 * transparency onto white (an already-transparent PNG must not read as ink).
 */
export async function loadSourceImage(file, maxDim = 2400) {
  const bitmap = await decode(file);
  const scale  = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(bitmap.width  * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas;
}

function decode(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => decodeViaImg(file));
  }
  return decodeViaImg(file);
}

function decodeViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  });
}

// ── Quad geometry (corners are [TL, TR, BR, BL] in source pixels) ────────────

export function makeQuad(width, height, inset = 0.04) {
  const ix = width * inset, iy = height * inset;
  return [
    [ix,         iy],
    [width - ix, iy],
    [width - ix, height - iy],
    [ix,         height - iy],
  ];
}

/** Rotate the *output* by 90° by re-labelling which corner is top-left. */
export function rotateQuad90(quad, dir = 1) {
  return dir > 0
    ? [quad[3], quad[0], quad[1], quad[2]]   // clockwise
    : [quad[1], quad[2], quad[3], quad[0]];  // counter-clockwise
}

/** Fine rotation: spin the quad about its own centre, leaving the source alone. */
export function rotateQuadBy(quad, degrees) {
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx  = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const cy  = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  return quad.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

export function quadOutputSize(quad, maxOut) {
  const d = (a, b) => Math.hypot(quad[a][0] - quad[b][0], quad[a][1] - quad[b][1]);
  const w = Math.max(d(0, 1), d(3, 2));
  const h = Math.max(d(0, 3), d(1, 2));
  const scale = Math.min(1, maxOut / Math.max(w, h, 1));
  return {
    width:  Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Projective map from the unit square onto the quad (Heckbert). Returns the
 * coefficients used to look up a source pixel for every destination pixel.
 */
function homography(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return { a: x1 - x0, b: x3 - x0, c: x0, d: y1 - y0, e: y3 - y0, f: y0, g: 0, h: 0 };
  }
  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) {
    return { a: x1 - x0, b: x3 - x0, c: x0, d: y1 - y0, e: y3 - y0, f: y0, g: 0, h: 0 };
  }
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  };
}

/** Sample the source through the quad into an upright image. */
export function warpQuad(source, quad, maxOut) {
  const src = source.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, source.width, source.height);
  const { width: W, height: H } = quadOutputSize(quad, maxOut);
  const m   = homography(quad);
  const out = new ImageData(W, H);
  const sw = src.width, sh = src.height, sd = src.data, od = out.data;

  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) / H;
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) / W;
      const w = m.g * u + m.h * v + 1;
      const sxf = (m.a * u + m.b * v + m.c) / w;
      const syf = (m.d * u + m.e * v + m.f) / w;
      const o = (py * W + px) * 4;

      if (sxf < 0 || syf < 0 || sxf > sw - 1 || syf > sh - 1) {
        od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255;
        continue;
      }
      const x0 = sxf | 0, y0 = syf | 0;
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = sxf - x0, fy = syf - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        od[o + c] = top * (1 - fy) + bot * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

// ── Illumination-normalised ink map ─────────────────────────────────────────

function downsample(src, w, h, f) {
  const w2 = Math.max(1, Math.floor(w / f));
  const h2 = Math.max(1, Math.floor(h / f));
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < f; dy++) {
        const sy = y * f + dy;
        if (sy >= h) break;
        for (let dx = 0; dx < f; dx++) {
          const sx = x * f + dx;
          if (sx >= w) break;
          sum += src[sy * w + sx];
          n++;
        }
      }
      out[y * w2 + x] = n ? sum / n : 1;
    }
  }
  return { data: out, width: w2, height: h2 };
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const xx = Math.min(w - 1, Math.max(0, x + d));
        const v = src[y * w + xx];
        if (v > m) m = v;
      }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let d = -r; d <= r; d++) {
        const yy = Math.min(h - 1, Math.max(0, y + d));
        const v = tmp[yy * w + x];
        if (v > m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[y * w + Math.min(w - 1, Math.max(0, x + d))];
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x];
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function upsample(src, w, h, W, H) {
  const out = new Float32Array(W * H);
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = fy | 0, y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = fx | 0, x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      const top = src[y0 * w + x0] * (1 - wx) + src[y0 * w + x1] * wx;
      const bot = src[y1 * w + x0] * (1 - wx) + src[y1 * w + x1] * wx;
      out[y * W + x] = top * (1 - wy) + bot * wy;
    }
  }
  return out;
}

/**
 * Per-pixel ink strength in 0..1, corrected for uneven lighting.
 * Taking the strongest darkening across R/G/B keeps coloured pens as visible
 * as black ones — a blue pen barely dents luminance but nearly empties red.
 */
export function inkMap(imageData) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const f = Math.max(1, Math.round(Math.max(w, h) / SMALL_TARGET));
  const ink = new Float32Array(n);
  ink.fill(1);

  for (let c = 0; c < 3; c++) {
    const chan = new Float32Array(n);
    for (let i = 0; i < n; i++) chan[i] = data[i * 4 + c] / 255;

    const small = downsample(chan, w, h, f);
    let bg = maxFilter(small.data, small.width, small.height, Math.min(MAX_FILTER_R, small.width, small.height));
    bg = boxBlur(bg, small.width, small.height, Math.min(BLUR_R, small.width, small.height));
    const paper = upsample(bg, small.width, small.height, w, h);

    for (let i = 0; i < n; i++) {
      const ratio = chan[i] / Math.max(paper[i], 0.004);
      const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
      if (clamped < ink[i]) ink[i] = clamped;   // keep the darkest ratio
    }
  }
  for (let i = 0; i < n; i++) ink[i] = 1 - ink[i];
  return ink;
}

/** Otsu's method over the ink histogram — the auto threshold. */
export function otsuThreshold(ink) {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (let i = 0; i < ink.length; i++) {
    let b = (ink[i] * bins) | 0;
    if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const total = ink.length;
  let sum = 0;
  for (let b = 0; b < bins; b++) sum += hist[b] * (b + 0.5) / bins;

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += hist[b] * (b + 0.5) / bins;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = (b + 1) / bins; }
  }
  return best;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Drop 8-connected components smaller than minArea. This is what removes
 * paper grain and dust; a blur would take the thin strokes with it.
 *
 * Also returns `interior` — the kept components that never touch the edge of
 * the crop. A table top or page edge caught in the crop is one huge
 * edge-touching blob, and letting it vote on the ink colour turns a blue pen
 * brown, so colour sampling uses the interior shapes instead.
 */
export function despeckleMask(mask, w, h, minArea) {
  const n = w * h;
  const out      = new Uint8Array(n);
  const interior = new Uint8Array(n);
  const label    = new Int32Array(n).fill(-1);
  const stack    = new Int32Array(n);
  const members  = new Int32Array(n);
  let components = 0, kept = 0, interiorCount = 0;

  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    let top = 0, count = 0, touchesEdge = false;
    stack[top++] = start;
    label[start] = components;

    while (top > 0) {
      const p = stack[--top];
      members[count++] = p;
      const px = p % w, py = (p / w) | 0;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) touchesEdge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && label[q] === -1) { label[q] = components; stack[top++] = q; }
        }
      }
    }
    components++;
    if (count >= minArea) {
      kept++;
      for (let i = 0; i < count; i++) out[members[i]] = 1;
      if (!touchesEdge) {
        interiorCount += count;
        for (let i = 0; i < count; i++) interior[members[i]] = 1;
      }
    }
  }
  return { mask: out, interior, interiorCount, components, kept };
}

function dilate1(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx]) { on = 1; break; }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/** Slider position (0..100) → minimum component area in pixels. */
export function despeckleMinArea(slider, totalPixels) {
  const frac = Math.pow(Math.max(0, Math.min(100, slider)) / 100, 2) * 0.004;
  return Math.max(1, Math.round(frac * totalPixels));
}

/**
 * Median ink colour, so a blue pen stays blue.
 *
 * Sampled from the darker half of the masked pixels only: every stroke is
 * mostly edge, and averaging the anti-aliased edges in turns a black pen grey.
 */
export function sampleInkColor(imageData, mask, ink) {
  let core = mask;
  if (ink) {
    const bins = 64;
    const inkHist = new Uint32Array(bins);
    let masked = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      masked++;
      let b = (ink[i] * bins) | 0;
      if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
      inkHist[b]++;
    }
    if (masked) {
      let acc = 0, cut = 0;
      for (let b = bins - 1; b >= 0; b--) {   // walk down from the darkest ink
        acc += inkHist[b];
        if (acc >= masked / 2) { cut = b / bins; break; }
      }
      core = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) core[i] = mask[i] && ink[i] >= cut ? 1 : 0;
    }
  }

  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) hist[c][imageData.data[i * 4 + c]]++;
  }
  if (!n) return '#1e293b';
  const median = c => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[c][v]; if (acc >= n / 2) return v; }
    return 0;
  };
  return rgbToHex(median(0), median(1), median(2));
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Turn a warped region plus its ink map into a transparent signature image.
 * Strokes get a soft ramp across the threshold so they stay smooth when the
 * stamp is scaled down onto a page.
 */
export function renderSignature(region, ink, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const { width: w, height: h } = region;
  const n = w * h;
  const threshold = p.threshold == null ? otsuThreshold(ink) : p.threshold;

  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = ink[i] > threshold ? 1 : 0;

  const minArea = despeckleMinArea(p.despeckle, n);
  const { mask, interior, interiorCount, components, kept } = despeckleMask(raw, w, h, minArea);
  const band = dilate1(mask, w, h);

  const inkColor = p.inkColor || sampleInkColor(region, interiorCount ? interior : mask, ink);
  const [ir, ig, ib] = hexToRgb(inkColor);

  const lo = threshold - EDGE_BAND, span = EDGE_BAND * 2;
  const out = new ImageData(w, h);
  let inkPixels = 0;
  for (let i = 0; i < n; i++) {
    let a = band[i] ? (ink[i] - lo) / span : 0;
    if (a < 0) a = 0; else if (a > 1) a = 1;
    const o = i * 4;
    out.data[o] = ir; out.data[o + 1] = ig; out.data[o + 2] = ib;
    out.data[o + 3] = Math.round(a * 255);
    if (a > 0) inkPixels++;
  }

  const image = p.trim ? trimTransparent(out) : out;
  return { image, threshold, inkColor, stats: { components, kept, inkPixels } };
}

/** Crop away empty margins so the stamp sits tight around the strokes. */
export function trimTransparent(imageData, padFrac = 0.02) {
  const { width: w, height: h, data } = imageData;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > ALPHA_FLOOR) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return imageData;

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * padFrac) + 1;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const src = ((y + minY) * w + minX) * 4;
    out.data.set(data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return out;
}

export function imageDataToCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width  = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas;
}

export function imageDataToDataURL(imageData) {
  return imageDataToCanvas(imageData).toDataURL('image/png');
}

// ── Cached pipeline ─────────────────────────────────────────────────────────

/**
 * Holds the warped region and its ink map so that moving the threshold or
 * despeckle sliders re-renders without redoing the expensive geometry pass.
 */
export class SignatureExtractor {
  constructor(source) {
    this.source = source;
    this._key   = null;
    this._region = null;
    this._ink    = null;
  }

  prepare(quad, maxOut) {
    const key = quad.map(pt => pt.map(v => Math.round(v * 100) / 100).join()).join('|') + '@' + maxOut;
    if (key !== this._key) {
      this._region = warpQuad(this.source, quad, maxOut);
      this._ink    = inkMap(this._region);
      this._key    = key;
    }
    return { region: this._region, ink: this._ink };
  }

  /** Otsu threshold for the current geometry — the slider's starting point. */
  autoThreshold(quad, maxOut) {
    const { ink } = this.prepare(quad, maxOut);
    return otsuThreshold(ink);
  }

  render(quad, maxOut, params) {
    const { region, ink } = this.prepare(quad, maxOut);
    return renderSignature(region, ink, params);
  }
}

// ── Colour helpers ──────────────────────────────────────────────────────────

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [30, 41, 59];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
