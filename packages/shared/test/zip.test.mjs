import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createZip, crc32, sanitizeZipEntryName } from "../src/lib/zip.js";

describe("zip generator", () => {
  it("crc32 matches known test vectors", () => {
    // "123456789" -> 0xcbf43926
    const ascii = new TextEncoder().encode("123456789");
    assert.equal(crc32(ascii), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  it("sanitizeZipEntryName strips invalid characters and slashes", () => {
    assert.equal(sanitizeZipEntryName("hello/world.mp4"), "hello_world.mp4");
    assert.equal(sanitizeZipEntryName("test:file?.mp3"), "test_file_.mp3");
    assert.equal(sanitizeZipEntryName("___"), "download");
    assert.equal(sanitizeZipEntryName(""), "download");
  });

  it("creates a well-formed ZIP with headers and records", async () => {
    const file1 = { name: "song1.mp3", data: new Uint8Array([1, 2, 3, 4, 5]) };
    const file2 = { name: "video 2.mp4", data: new Uint8Array([10, 20, 30]) };

    const blob = createZip([file1, file2]);
    assert.equal(blob.type, "application/zip");

    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);

    // First local file header signature
    assert.equal(view.getUint32(0, true), 0x04034b50);

    // EOCD at the end (last 22 bytes)
    const eocdOffset = buf.length - 22;
    assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
    // Number of records
    assert.equal(view.getUint16(eocdOffset + 8, true), 2);
    assert.equal(view.getUint16(eocdOffset + 10, true), 2);
  });

  it("handles UTF-8 filenames correctly", async () => {
    const file = { name: "テスト日本語.mp4", data: new Uint8Array([42]) };
    const blob = createZip([file]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buf.buffer);

    // Local file header signature
    assert.equal(view.getUint32(0, true), 0x04034b50);
    // Bit 11 UTF-8 flag set
    assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
  });
});
