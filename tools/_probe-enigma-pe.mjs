import fs from "node:fs";

const p = process.argv[2];
const fd = fs.openSync(p, "r");
for (const pos of [0x1cb39600, 0x1cb39952, 0x1cb3972b, 0x1cb39ba8]) {
  const buf = Buffer.alloc(96);
  fs.readSync(fd, buf, 0, 96, pos);
  console.log("0x" + pos.toString(16), JSON.stringify(buf.toString("latin1").replace(/[ -~]/g, (c) => c).replace(/[^ -~]/g, ".")));
}
fs.closeSync(fd);
