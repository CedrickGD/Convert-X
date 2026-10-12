// Zero-dependency streaming ZIP (Store mode) generator.
// Produces standard ZIP files with UTF-8 filename support that extract
// cleanly in Windows Explorer, macOS Archive Utility, 7-Zip, Linux and Android.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/** Compute CRC-32 checksum of a byte buffer. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** Clean a filename so it is safe inside a ZIP archive. */
export function sanitizeZipEntryName(name) {
  const cleaned = String(name || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  return cleaned || "download";
}

/**
 * Creates a standard ZIP archive from an array of files without external dependencies.
 * Each entry: { name: string, data: Uint8Array }.
 * Returns a Blob with mime type application/zip.
 */
export function createZip(files) {
  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  const parts = [];
  const centralRecords = [];
  let offset = 0;

  for (const file of files) {
    const rawName = sanitizeZipEntryName(file.name);
    const nameBytes = encoder.encode(rawName);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || 0);
    const size = data.length;
    const crc = crc32(data);

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lView = new DataView(localHeader.buffer);

    lView.setUint32(0, 0x04034b50, true); // Local file header signature
    lView.setUint16(4, 20, true);          // Version needed (2.0)
    lView.setUint16(6, 0x0800, true);       // General purpose bit flag: bit 11 = UTF-8
    lView.setUint16(8, 0, true);            // Compression: 0 (Store)
    lView.setUint16(10, dosTime, true);     // Last mod time
    lView.setUint16(12, dosDate, true);     // Last mod date
    lView.setUint32(14, crc, true);         // CRC-32
    lView.setUint32(18, size, true);        // Compressed size
    lView.setUint32(22, size, true);        // Uncompressed size
    lView.setUint16(26, nameBytes.length, true); // Filename length
    lView.setUint16(28, 0, true);           // Extra field length
    localHeader.set(nameBytes, 30);

    const localOffset = offset;
    parts.push(localHeader);
    parts.push(data);
    offset += localHeader.length + size;

    // Central directory header (46 bytes + name length)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(centralHeader.buffer);

    cView.setUint32(0, 0x02014b50, true); // Central directory signature
    cView.setUint16(4, 20, true);          // Version made by (2.0)
    cView.setUint16(6, 20, true);          // Version needed (2.0)
    cView.setUint16(8, 0x0800, true);       // General purpose bit flag: bit 11 = UTF-8
    cView.setUint16(10, 0, true);           // Compression: 0 (Store)
    cView.setUint16(12, dosTime, true);     // Last mod time
    cView.setUint16(14, dosDate, true);     // Last mod date
    cView.setUint32(16, crc, true);         // CRC-32
    cView.setUint32(20, size, true);        // Compressed size
    cView.setUint32(24, size, true);        // Uncompressed size
    cView.setUint16(28, nameBytes.length, true); // Filename length
    cView.setUint16(30, 0, true);           // Extra field length
    cView.setUint16(32, 0, true);           // File comment length
    cView.setUint16(34, 0, true);           // Disk number start
    cView.setUint16(36, 0, true);           // Internal file attributes
    cView.setUint32(38, 0, true);           // External file attributes
    cView.setUint32(42, localOffset, true); // Relative offset of local header
    centralHeader.set(nameBytes, 46);

    centralRecords.push(centralHeader);
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralRecords) {
    parts.push(c);
    centralSize += c.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);           // EOCD signature
  eView.setUint16(4, 0, true);                    // Disk number
  eView.setUint16(6, 0, true);                    // Disk with start of CD
  eView.setUint16(8, files.length, true);         // Number of CD records on disk
  eView.setUint16(10, files.length, true);        // Total CD records
  eView.setUint32(12, centralSize, true);         // Size of CD
  eView.setUint32(16, centralOffset, true);       // Offset of start of CD
  eView.setUint16(20, 0, true);                   // Comment length
  parts.push(eocd);

  return new Blob(parts, { type: "application/zip" });
}
