import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateDelta, reconstruct, refreshDeltas, validateDeltas } from "./plugin-deltas.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("a release delta is generated, verified and bound to both archives", { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "lithe-store-delta-test-"));
  const previousDirectory = process.cwd();
  try {
    const base = Buffer.concat(Array.from({ length: 256 }, (_, i) => Buffer.from(digest(String(i)), "hex")));
    const target = Buffer.from(base);
    Buffer.from("changed plugin archive").copy(target, 1024);
    writeFileSync(join(scratch, "old.zip"), base);
    writeFileSync(join(scratch, "new.zip"), target);
    process.chdir(scratch);
    const path = generateDelta("old.zip", "new.zip", "1.0.0");
    const patch = readFileSync(path);
    assert.ok(patch.length < 256);
    assert.deepEqual(reconstruct(base, patch, target.length), target);

    const repo = "https://github.com/example/delta/releases/download";
    const version = (version, asset, bytes) => ({
      version,
      downloads: [{ platforms: ["darwin-arm64"], downloadURL: `${repo}/v${version}/${asset}`, sha256: digest(bytes) }],
    });
    const old = version("1.0.0", "old.zip", base);
    const next = version("1.1.0", "new.zip", target);
    const market = { plugins: [{ id: "io.example.delta", versions: [next, old] }] };
    const previous = { plugins: [{ id: "io.example.delta", versions: [old] }] };
    const urls = new Map([
      [old.downloads[0].downloadURL, base],
      [next.downloads[0].downloadURL, target],
      [`${repo}/v1.1.0/new.from-1.0.0.zip.zst`, patch],
    ]);
    const empty = { schemaVersion: 0, patches: [] };
    const refresh = async (url) => urls.get(url);
    const index = await refreshDeltas(empty, market, previous, refresh);
    assert.equal(index.patches.length, 1);
    assert.equal(index.patches[0].sha256, digest(patch));
    const intermediate = version("1.0.1", "intermediate.zip", base);
    const batch = { plugins: [{ id: "io.example.delta", versions: [next, intermediate, old] }] };
    assert.deepEqual(await refreshDeltas(empty, batch, previous, refresh), index);
    const advanced = { plugins: [{ id: "io.example.delta", versions: [intermediate, old] }] };
    assert.deepEqual(await refreshDeltas(empty, batch, advanced, refresh), index);
    assert.doesNotThrow(() => validateDeltas(index, market));
    assert.throws(() => validateDeltas(index, previous), /invalid marketplace delta/);
    assert.deepEqual(await refreshDeltas(index, previous, market, refresh), empty);
    urls.set(index.patches[0].downloadURL, Buffer.from("corrupt zstd patch"));
    await assert.rejects(refreshDeltas(empty, market, previous, refresh));
  } finally {
    process.chdir(previousDirectory);
    rmSync(scratch, { recursive: true, force: true });
  }
});
