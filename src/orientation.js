// Reads the EXIF Orientation of a JPEG and neutralises it, so that the orientation
// is applied exactly once, by us, instead of depending on how the Images binding treats the tag.
const ORIENTATION_OPS = {
  2: { flip: "h" },
  3: { rotate: 180 },
  4: { flip: "v" },
  5: { flip: "h", rotate: 270 },
  6: { rotate: 90 },
  7: { flip: "h", rotate: 90 },
  8: { rotate: 270 }
};

export function normalizeOrientation(input) {
  const bytes = new Uint8Array(input);
  let orientation = 1;
  try {
    if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 4 <= bytes.length && bytes[i] === 0xff) {
        const marker = bytes[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xda || marker === 0xd9) break;
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (len < 2) break;
        const isExif = marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66 && bytes[i + 8] === 0 && bytes[i + 9] === 0;
        if (isExif) {
          const tiff = i + 10;
          const end = Math.min(bytes.length, i + 2 + len);
          const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
          const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
          if (!little && !big) break;
          const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
          const u32 = (o) => (little ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
          const ifd = tiff + u32(tiff + 4);
          if (ifd + 2 > end) break;
          const count = u16(ifd);
          for (let n = 0; n < count; n++) {
            const e = ifd + 2 + n * 12;
            if (e + 12 > end) break;
            if (u16(e) === 0x0112) {
              const value = u16(e + 8);
              if (value >= 1 && value <= 8) {
                orientation = value;
                if (little) { bytes[e + 8] = 1; bytes[e + 9] = 0; } else { bytes[e + 8] = 0; bytes[e + 9] = 1; }
              }
              break;
            }
          }
          break;
        }
        i += 2 + len;
      }
    }
  } catch (error) {
    console.error("IPX LAB orientation parse error", error);
    orientation = 1;
  }
  return { orientation, bytes };
}

export async function prepareImage(response) {
  const { orientation, bytes } = normalizeOrientation(await response.arrayBuffer());
  return { stream: new Response(bytes).body, rotation: ORIENTATION_OPS[orientation] || null, orientation };
}
