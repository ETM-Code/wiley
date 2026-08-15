import { describe, expect, it } from "vitest";

import { IMAGE_MIME_BY_EXT, sniffImageSize } from "../src/main/pi/image";

function pngHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  data.write("\x89PNG\r\n\x1a\n", 0, "binary");
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function gifHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.write("GIF89a", 0, "ascii");
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return data;
}

/** SOI, then one skipped APP0 segment, then an SOF0 frame carrying the size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(2 + 2 + 12);
  app0.writeUInt8(0xff, 0);
  app0.writeUInt8(0xe0, 1);
  app0.writeUInt16BE(14, 2);
  const sof0 = Buffer.alloc(2 + 2 + 15);
  sof0.writeUInt8(0xff, 0);
  sof0.writeUInt8(0xc0, 1);
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

describe("IMAGE_MIME_BY_EXT", () => {
  it("maps both jpeg spellings to the same mime type", () => {
    expect(IMAGE_MIME_BY_EXT[".jpg"]).toBe("image/jpeg");
    expect(IMAGE_MIME_BY_EXT[".jpeg"]).toBe("image/jpeg");
  });

  it("has no entry for an unsupported extension", () => {
    expect(IMAGE_MIME_BY_EXT[".bmp"]).toBeUndefined();
  });
});

describe("sniffImageSize", () => {
  it("reads PNG dimensions from the IHDR chunk", () => {
    expect(sniffImageSize(pngHeader(1280, 720), "image/png")).toEqual({ width: 1280, height: 720 });
  });

  it("reads GIF dimensions little-endian from the logical screen descriptor", () => {
    expect(sniffImageSize(gifHeader(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
  });

  it("walks JPEG segments to the start-of-frame marker", () => {
    expect(sniffImageSize(jpegHeader(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  it("returns undefined for a truncated PNG", () => {
    expect(sniffImageSize(pngHeader(10, 10).subarray(0, 20), "image/png")).toBeUndefined();
  });

  it("returns undefined for a truncated GIF", () => {
    expect(sniffImageSize(gifHeader(10, 10).subarray(0, 8), "image/gif")).toBeUndefined();
  });

  it("returns undefined when JPEG bytes never reach a frame header", () => {
    expect(sniffImageSize(Buffer.alloc(64), "image/jpeg")).toBeUndefined();
  });

  it("returns undefined for a mime type it cannot measure", () => {
    expect(sniffImageSize(pngHeader(10, 10), "image/svg+xml")).toBeUndefined();
    expect(sniffImageSize(pngHeader(10, 10), "image/webp")).toBeUndefined();
  });
});
