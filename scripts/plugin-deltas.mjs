import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareVersions } from "./track-releases.mjs";

const maxZIP = 64 * 2 ** 20;
const timeLimit = 60_000;
const hex = /^[a-f0-9]{64}$/;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const names = ["pluginID", "platform", "fromVersion", "fromSHA256", "toVersion",
  "toSHA256", "toSize", "format", "downloadURL", "sha256", "size"];
const indexFile = "lithe-plugin-index.json";
const deltasFile = "lithe-plugin-deltas.json";

function archiveFor(entry, version, platform) {
  return entry.versions.find((item) => item.version === version)
    ?.downloads.find((archive) => archive.platforms.includes(platform));
}

function patchURL(target, fromVersion) {
  return target.replace(/\.zip$/i, `.from-${fromVersion}.zip.zst`);
}

const key = p => JSON.stringify([p.pluginID, p.platform, p.fromVersion, p.toVersion]);

function referencedArchives(market, p) {
  const entry = market.plugins.find((item) => item.id === p.pluginID);
  const base = entry && archiveFor(entry, p.fromVersion, p.platform);
  const target = entry && archiveFor(entry, p.toVersion, p.platform);
  return { base, target };
}

export function validateDeltas(index, market) {
  if (index?.schemaVersion !== 0 || Object.keys(index).length !== 2 ||
      !Array.isArray(index.patches) || index.patches.length > 20_000) {
    throw new Error("invalid marketplace delta index");
  }
  const known = new Set();
  for (const p of index.patches) {
    const { base, target } = referencedArchives(market, p ?? {});
    if (!p || Object.keys(p).length !== names.length || !names.every((name) => Object.hasOwn(p, name)) ||
        !base || base.sha256 !== p.fromSHA256 || !target || target.sha256 !== p.toSHA256 ||
        compareVersions(p.fromVersion, p.toVersion) >= 0 ||
        p.format !== "zstd-prefix" || p.downloadURL !== patchURL(target.downloadURL, p.fromVersion) ||
        !Number.isInteger(p.toSize) || p.toSize < 1 || p.toSize > maxZIP ||
        !Number.isInteger(p.size) || p.size < 1 || p.size > Math.floor(p.toSize * 3 / 4) ||
        typeof p.sha256 !== "string" || !hex.test(p.sha256) || known.has(key(p))) {
      throw new Error(`invalid marketplace delta ${p?.pluginID ?? "entry"}`);
    }
    known.add(key(p));
  }
}

async function fetchBytes(url, limit, optional = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeLimit) });
  if (optional && response.status === 404) return null;
  if (!response.ok || new URL(response.url).protocol !== "https:") {
    throw new Error(`Cannot read ${url} (HTTP ${response.status})`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error(`Size limit exceeded for ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function reconstruct(base, patch, targetSize) {
  const scratch = mkdtempSync(join(tmpdir(), "lithe-store-delta-"));
  try {
    const basePath = join(scratch, "base.zip");
    const patchPath = join(scratch, "plugin.zip.zst");
    writeFileSync(basePath, base);
    writeFileSync(patchPath, patch);
    return execFileSync("zstd", ["-q", "-dc", "-M128MB", `--patch-from=${basePath}`, "--", patchPath],
      { timeout: timeLimit, maxBuffer: targetSize, stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function verify(base, patch, p, read) {
  const bytes = await read(base.downloadURL, maxZIP);
  if (sha(bytes) !== p.fromSHA256 || patch.length !== p.size || sha(patch) !== p.sha256) {
    throw new Error(`Asset checksum mismatch for ${p.downloadURL}`);
  }
  const target = reconstruct(bytes, patch, p.toSize);
  if (target.length !== p.toSize || sha(target) !== p.toSHA256) {
    throw new Error(`Delta does not reconstruct the indexed ZIP for ${p.downloadURL}`);
  }
}

export async function refreshDeltas(index, market, previous, read = fetchBytes, report = (error) => { throw error; }) {
  // A withdrawn version disappears from both feeds in the same commit.
  const patches = index.patches.filter((p) => {
    const { base, target } = referencedArchives(market, p);
    return base?.sha256 === p.fromSHA256 && target?.sha256 === p.toSHA256;
  });
  for (const entry of market.plugins) {
    const known = previous.plugins.find((p) => p.id === entry.id)?.versions ?? [];
    for (const target of entry.versions) {
      if (known.some((item) => item.version === target.version)) continue;
      for (const archive of target.downloads) {
        for (const platform of archive.platforms) {
          const from = entry.versions.find((item) => compareVersions(item.version, target.version) < 0 &&
            archiveFor(entry, item.version, platform));
          if (!from) continue;
          const base = archiveFor(entry, from.version, platform);
          const downloadURL = patchURL(archive.downloadURL, from.version);
          try {
            const patch = await read(downloadURL, maxZIP * 3 / 4, true);
            if (!patch) continue;
            const zip = await read(archive.downloadURL, maxZIP);
            if (sha(zip) !== archive.sha256) throw new Error(`Target checksum mismatch for ${archive.downloadURL}`);
            const p = { pluginID: entry.id, platform, fromVersion: from.version, fromSHA256: base.sha256,
              toVersion: target.version, toSHA256: archive.sha256, toSize: zip.length,
              format: "zstd-prefix", downloadURL, sha256: sha(patch), size: patch.length };
            // A publisher can include a valid but unhelpful patch. The Store only advertises savings.
            if (p.size > Math.floor(p.toSize * 3 / 4)) continue;
            await verify(base, patch, p, read);
            if (!patches.some((other) => key(other) === key(p))) patches.push(p);
          } catch (error) {
            // An optional bad asset must not prevent publishing the full package.
            report(error);
          }
        }
      }
    }
  }
  patches.sort((a, b) => key(a).localeCompare(key(b), "en"));
  const updated = { schemaVersion: 0, patches };
  validateDeltas(updated, market);
  return updated;
}

export function generateDelta(base, target, fromVersion) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(fromVersion) ||
      !target.toLowerCase().endsWith(".zip") || statSync(base).size > maxZIP || statSync(target).size > maxZIP) {
    throw new Error("expected a base version and ZIP archives up to 64 MiB");
  }
  const scratch = mkdtempSync(join(tmpdir(), "lithe-generate-delta-"));
  try {
    const candidate = join(scratch, "candidate.zip.zst");
    execFileSync("zstd", ["-q", "-M128MB", `--patch-from=${resolve(base)}`, "-o", candidate, "--", resolve(target)],
      { timeout: timeLimit, stdio: ["ignore", "pipe", "pipe"] });
    const toSize = statSync(target).size;
    if (statSync(candidate).size > Math.floor(toSize * 3 / 4)) return null;
    const output = resolve(patchURL(basename(target), fromVersion));
    const bytes = reconstruct(readFileSync(base), readFileSync(candidate), toSize);
    if (sha(bytes) !== sha(readFileSync(target))) throw new Error("generated delta does not reconstruct target ZIP");
    writeFileSync(output, readFileSync(candidate), { flag: "wx" });
    return output;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const json = path => JSON.parse(readFileSync(path));
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, base, target, fromVersion] = process.argv.slice(2);
  if (action === "generate" && base && target && fromVersion) {
    const output = generateDelta(base, target, fromVersion);
    if (output) console.log(output);
  } else if (action === "refresh" && base) {
    const updated = await refreshDeltas(json(deltasFile), json(indexFile), json(base), fetchBytes,
      (error) => console.warn(`Plugin delta skipped: ${error.message}`));
    const temporary = deltasFile + ".tmp";
    writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, deltasFile);
  } else if (action === "validate") {
    const index = json(deltasFile);
    const market = json(indexFile);
    validateDeltas(index, market);
    const previous = base ? json(base) : { patches: [] };
    for (const p of index.patches) {
      if (previous.patches.some((other) => JSON.stringify(other) === JSON.stringify(p))) continue;
      await verify(referencedArchives(market, p).base, await fetchBytes(p.downloadURL, p.size), p, fetchBytes);
    }
  } else {
    throw new Error("usage: plugin-deltas.mjs generate OLD.zip NEW.zip OLD_VERSION | refresh BASE_INDEX.json | validate [BASE_DELTAS.json]");
  }
}
