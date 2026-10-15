const fs = require("fs");
const sharp = require("sharp");
const [src, dst, size] = process.argv.slice(2);
sharp(fs.readFileSync(src), { density: 384 })
  .resize(Number(size), Number(size))
  .flatten()
  .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
  .toFile(dst)
  .catch((error) => { console.error(error); process.exit(1); });
