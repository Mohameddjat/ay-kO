// Tiny pure-Node ZIP writer for the dist/ folder. STORE-only entries (no compression
// at the file level), which keeps size similar for already-compressed assets like mp3
// and is well-supported by every browser / itch.io. Pure stdlib — no extra deps.
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const root = path.resolve(process.cwd(), 'dist');
const outPath = path.resolve(process.cwd(), 'exports/gearshift-itch.zip');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p, rel));
    else out.push({ rel, abs: p, size: st.size });
  }
  return out;
}

const files = walk(root);
const localChunks = [];
const centralChunks = [];
let offset = 0;

const dosTime = (() => {
  const d = new Date();
  const t = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const dt = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { t, dt };
})();

for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const crc = crc32(data);
  const nameBuf = Buffer.from(f.rel, 'utf8');

  // Local file header
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);                  // version needed
  lfh.writeUInt16LE(0, 6);                   // flags
  lfh.writeUInt16LE(0, 8);                   // method = STORE
  lfh.writeUInt16LE(dosTime.t, 10);
  lfh.writeUInt16LE(dosTime.dt, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(data.length, 18);        // compressed size
  lfh.writeUInt32LE(data.length, 22);        // uncompressed size
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);                  // extra len

  localChunks.push(lfh, nameBuf, data);

  // Central directory record
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);                  // version made by
  cdh.writeUInt16LE(20, 6);                  // version needed
  cdh.writeUInt16LE(0, 8);                   // flags
  cdh.writeUInt16LE(0, 10);                  // method
  cdh.writeUInt16LE(dosTime.t, 12);
  cdh.writeUInt16LE(dosTime.dt, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);                  // extra len
  cdh.writeUInt16LE(0, 32);                  // comment len
  cdh.writeUInt16LE(0, 34);                  // disk #
  cdh.writeUInt16LE(0, 36);                  // internal attrs
  cdh.writeUInt32LE(0, 38);                  // external attrs
  cdh.writeUInt32LE(offset, 42);             // local header offset
  centralChunks.push(cdh, nameBuf);

  offset += lfh.length + nameBuf.length + data.length;
}

const centralStart = offset;
const centralBuf = Buffer.concat(centralChunks);
const centralSize = centralBuf.length;

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);

const ws = fs.createWriteStream(outPath);
for (const c of localChunks) ws.write(c);
ws.write(centralBuf);
ws.write(eocd);
ws.end(() => {
  const sz = fs.statSync(outPath).size;
  console.log(`OK ${outPath}  ${(sz / 1024 / 1024).toFixed(2)} MB  ${files.length} files`);
});
