import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { screenshotResult } from "../dist/screenshot.js";

test("screenshot returns exact 3x nearest-neighbor pixels without changing the native PNG", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mgba-screenshot-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "native.png");
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const native = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();
  await writeFile(path, native);
  const result = await screenshotResult(path);
  assert.equal(result.content[1].type, "image");
  const { data, info } = await sharp(Buffer.from(result.content[1].data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 6);
  assert.equal(info.height, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    const source = (Math.floor(y / 3) * 2 + Math.floor(x / 3)) * 3;
    assert.deepEqual(data.subarray((y * 6 + x) * 3, (y * 6 + x + 1) * 3), pixels.subarray(source, source + 3));
  }
  assert.deepEqual(await readFile(path), native);
});
