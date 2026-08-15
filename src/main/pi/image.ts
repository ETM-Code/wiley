export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function sniffImageSize(data: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png" && data.length >= 24) {
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    if (mime === "image/gif" && data.length >= 10) {
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) break;
        const marker = data[offset + 1];
        const size = data.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        }
        offset += 2 + size;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
