// Turns an uploaded photo into the three versions the site uses:
//   thumb   – gallery grid, long edge ≤ 1200px
//   display – piece page,   long edge ≤ 2000px
//   full    – zoom viewer,  original pixel size (capped for iOS canvas limits)

export const VERSIONS = {
  thumb: { maxEdge: 1200, quality: 0.8 },
  display: { maxEdge: 2000, quality: 0.85 },
  full: { maxEdge: Infinity, quality: 0.95 },
};

// iOS Safari refuses to draw canvases above ~16.7 million pixels
const MAX_PIXELS = 16_000_000;

const decode = async (file) => {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older Safari: fall back to an <img>, which also applies photo rotation
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

const sizeOf = (source) => ({
  width: source.naturalWidth || source.width,
  height: source.naturalHeight || source.height,
});

const fit = ({ width, height }, maxEdge, maxPixels = Infinity) => {
  let scale = Math.min(1, maxEdge / Math.max(width, height));
  scale = Math.min(scale, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

const makeCanvas = ({ width, height }) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

// Halving in steps gives a much smoother result than one big downscale
const resize = (source, target) => {
  let current = source;
  let size = sizeOf(source);
  while (size.width / 2 >= target.width && size.height / 2 >= target.height) {
    size = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
    const step = makeCanvas(size);
    const ctx = step.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(current, 0, 0, size.width, size.height);
    if (current instanceof HTMLCanvasElement) current.width = 0; // free memory early
    current = step;
  }
  const canvas = makeCanvas(target);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, 0, 0, target.width, target.height);
  if (current instanceof HTMLCanvasElement && current !== canvas) current.width = 0;
  return canvas;
};

const encode = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// Safari can't encode WebP and silently returns PNG instead, so fall back to JPEG
const toBlob = async (canvas, quality) => {
  const webp = await encode(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return { blob: webp, ext: "webp" };
  const jpeg = await encode(canvas, "image/jpeg", quality);
  if (!jpeg) throw new Error("This browser couldn't save the image.");
  return { blob: jpeg, ext: "jpg" };
};

/**
 * Returns { width, height, versions: { thumb, display, full } }
 * where each version is { blob, ext }. width/height describe the full version.
 */
export const processImage = async (file) => {
  let source;
  try {
    source = await decode(file);
  } catch {
    throw new Error("That file couldn't be read as an image. Try a JPEG or PNG.");
  }

  const original = sizeOf(source);
  const fullSize = fit(original, Infinity, MAX_PIXELS);
  const versions = {};

  for (const [name, { maxEdge, quality }] of Object.entries(VERSIONS)) {
    const target = fit(fullSize, maxEdge);
    const canvas = resize(source, target);
    versions[name] = await toBlob(canvas, quality);
    canvas.width = 0;
  }

  if (source.close) source.close();
  return { ...fullSize, versions };
};
