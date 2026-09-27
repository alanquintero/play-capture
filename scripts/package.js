const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const outputDir = path.join(root, "dist");
const outputPath = path.join(outputDir, `play-capture-v${version}.zip`);
const includedRoots = ["manifest.json", "background.js", "content.js", "offscreen", "popup", "assets"];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function filesUnder(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = fs.statSync(absoluteRoot).isDirectory()
    ? fs.readdirSync(absoluteRoot, { withFileTypes: true })
    : [];
  if (!entries.length) {
    return fs.statSync(absoluteRoot).isFile() ? [relativeRoot] : [];
  }

  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    return entry.isDirectory() ? filesUnder(relativePath) : [relativePath];
  });
}

function zipFile(relativePath) {
  const name = relativePath.split(path.sep).join("/");
  const nameBuffer = Buffer.from(name);
  const data = fs.readFileSync(path.join(root, relativePath));
  const checksum = crc32(data);
  const header = Buffer.concat([
    Buffer.from("PK\x03\x04", "binary"),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(checksum),
    uint32(data.length),
    uint32(data.length),
    uint16(nameBuffer.length),
    uint16(0),
    nameBuffer,
  ]);
  return { name, data, local: Buffer.concat([header, data]) };
}

const files = includedRoots.flatMap(filesUnder).sort();
const entries = files.map(zipFile);
let offset = 0;
const localParts = [];
const centralParts = [];

for (const entry of entries) {
  localParts.push(entry.local);
  const nameBuffer = Buffer.from(entry.name);
  centralParts.push(Buffer.concat([
    Buffer.from("PK\x01\x02", "binary"),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(crc32(entry.data)),
    uint32(entry.data.length),
    uint32(entry.data.length),
    uint16(nameBuffer.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(offset),
    nameBuffer,
  ]));
  offset += entry.local.length;
}

const centralDirectory = Buffer.concat(centralParts);
const archive = Buffer.concat([
  ...localParts,
  centralDirectory,
  Buffer.from("PK\x05\x06\x00\x00\x00\x00", "binary"),
  uint16(entries.length),
  uint16(entries.length),
  uint32(centralDirectory.length),
  uint32(offset),
  uint16(0),
]);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, archive);
console.log(`Created ${path.relative(root, outputPath)} with ${entries.length} files.`);
