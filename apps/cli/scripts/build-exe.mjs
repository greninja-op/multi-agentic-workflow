#!/usr/bin/env node
/**
 * Build a self-contained CFLS CLI using Node's Single Executable Application
 * (SEA) support.
 *
 * This is deliberately usable from a Linux release machine:
 *
 *   pnpm -C apps/cli package:linux
 *   pnpm -C apps/cli package:win
 *
 * `package:win` generates a real PE/Windows `cfls.exe` even when it is run on
 * Linux. It builds a portable JavaScript SEA blob locally, downloads the exact
 * matching official Node Windows runtime, verifies it against Node's published
 * SHA-256 manifest, and injects the blob with postject. No target machine needs
 * Node, pnpm, or this repository.
 *
 * The script also accepts a locally supplied base runtime when a release build
 * must be fully offline:
 *
 *   node scripts/build-exe.mjs --target win-x64 --node-binary /media/node.exe
 *   node scripts/build-exe.mjs --target linux-x64 --output /tmp/cfls
 *
 * The Node runtime used as the base must be the same Node version that runs
 * this script. SEA blobs are tied to that runtime version.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const outDir = join(appDir, "dist-exe");
const bundlePath = join(outDir, "cfls.cjs");
const blobPath = join(outDir, "cfls.blob");
const nodeVersion = process.versions.node;
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const WINDOWS_NODE_PATH = "win-x64/node.exe";

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    "Usage: node scripts/build-exe.mjs [--target <linux-x64|linux-arm64|win-x64>]",
    "                                 [--output <path>] [--node-binary <path>]",
    "",
    `Default target: ${platform()}-${arch() === "x64" ? "x64" : arch()}`,
    "",
    "For win-x64, the official matching Node runtime is downloaded and SHA-256",
    "verified unless --node-binary is supplied.",
  ].join("\n");
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (
      token !== "--target" &&
      token !== "--output" &&
      token !== "--node-binary"
    ) {
      fail(`Unknown option: ${token}\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for ${token}.`);
    }
    values.set(token, value);
    index += 1;
  }
  return values;
}

function normalizeTarget(value) {
  const requested = value ?? `${platform()}-${arch()}`;
  if (requested === "linux") {
    return `linux-${arch()}`;
  }
  if (requested === "win" || requested === "windows") {
    return "win-x64";
  }
  return requested;
}

function assertSupportedTarget(target) {
  if (!new Set(["linux-x64", "linux-arm64", "win-x64"]).has(target)) {
    fail(
      `Unsupported target "${target}". Supported targets are linux-x64, linux-arm64, and win-x64.`,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fetchBytes(url) {
  return fetch(url).then(async (response) => {
    if (!response.ok) {
      fail(`Download failed (${response.status}) for ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  });
}

function nodeReleaseUrl(path) {
  return `https://nodejs.org/download/release/v${nodeVersion}/${path}`;
}

async function releaseManifest() {
  return (await fetchBytes(nodeReleaseUrl("SHASUMS256.txt"))).toString("utf8");
}

function checksumFromManifest(manifest, assetPath) {
  const checksum = manifest
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts.length === 2 && parts[1] === assetPath)?.[0];
  if (checksum === undefined || !/^[a-f0-9]{64}$/iu.test(checksum)) {
    fail(
      `Could not find a SHA-256 checksum for ${assetPath} in Node v${nodeVersion}'s manifest.`,
    );
  }
  return checksum;
}

/** Download a Node release asset atomically and verify Node's published checksum. */
async function downloadVerifiedNodeAsset(assetPath, cachePath) {
  const manifest = await releaseManifest();
  const checksum = checksumFromManifest(manifest, assetPath);

  if (existsSync(cachePath)) {
    const cached = sha256(readFileSync(cachePath));
    if (cached.toLowerCase() === checksum.toLowerCase()) {
      return cachePath;
    }
    rmSync(cachePath, { force: true });
  }

  const binary = await fetchBytes(nodeReleaseUrl(assetPath));
  const actual = sha256(binary);
  if (actual.toLowerCase() !== checksum.toLowerCase()) {
    fail(
      `SHA-256 verification failed for the downloaded Node runtime (expected ${checksum}, got ${actual}).`,
    );
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, binary, { mode: 0o600 });
    renameSync(temporary, cachePath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return cachePath;
}

/**
 * Resolve an official Linux Node runtime. Distribution-packaged Node binaries
 * sometimes omit SEA's sentinel fuse, which makes postject fail after a costly
 * build. Always using the upstream runtime keeps Linux and cross-target builds
 * reproducible and gives the blob generator the same Node version as its base.
 */
async function resolveOfficialLinuxNode(targetArch) {
  if (platform() !== "linux") {
    fail(
      `Building a SEA blob from this host is unsupported on ${platform()}. Run the release build on Linux.`,
    );
  }
  if (targetArch !== "x64" && targetArch !== "arm64") {
    fail(`Unsupported Linux Node architecture: ${targetArch}`);
  }
  const archiveName = `node-v${nodeVersion}-linux-${targetArch}.tar.xz`;
  const cacheDir = join(outDir, ".node-bases");
  const archivePath = join(cacheDir, archiveName);
  const extractedDir = join(cacheDir, archiveName.slice(0, -".tar.xz".length));
  const nodePath = join(extractedDir, "bin", "node");

  if (existsSync(nodePath)) {
    return nodePath;
  }
  console.log(
    `Downloading verified Node v${nodeVersion} Linux ${targetArch} runtime…`,
  );
  await downloadVerifiedNodeAsset(archiveName, archivePath);
  try {
    mkdirSync(cacheDir, { recursive: true });
    // The archive is checksum-verified before extraction and comes directly
    // from nodejs.org. `tar` is used rather than a JS xz decoder to keep this
    // release script dependency-free.
    run("tar", ["-xJf", archivePath, "-C", cacheDir]);
  } catch (error) {
    rmSync(extractedDir, { recursive: true, force: true });
    throw error;
  }
  if (!existsSync(nodePath)) {
    fail(`Node archive did not contain the expected runtime: ${nodePath}`);
  }
  return nodePath;
}

async function resolveWindowsNodeBase(explicitPath) {
  if (explicitPath !== undefined) {
    const absolute = resolve(process.cwd(), explicitPath);
    if (!existsSync(absolute)) {
      fail(`--node-binary does not exist: ${absolute}`);
    }
    return absolute;
  }

  const cachePath = join(
    outDir,
    ".node-bases",
    `node-v${nodeVersion}-win-x64.exe`,
  );
  if (existsSync(cachePath)) {
    // Revalidate the cache against the published release manifest. This is a
    // small request and prevents a stale/corrupt `.node-bases` file becoming a
    // release artifact.
    return downloadVerifiedNodeAsset(WINDOWS_NODE_PATH, cachePath);
  }
  console.log(`Downloading verified Node v${nodeVersion} Windows x64 runtime…`);
  return downloadVerifiedNodeAsset(WINDOWS_NODE_PATH, cachePath);
}

async function resolveLinuxNodeBase(target, explicitPath) {
  if (explicitPath !== undefined) {
    const absolute = resolve(process.cwd(), explicitPath);
    if (!existsSync(absolute)) {
      fail(`--node-binary does not exist: ${absolute}`);
    }
    return absolute;
  }
  return resolveOfficialLinuxNode(target.slice("linux-".length));
}

function defaultOutput(target) {
  if (target === "win-x64") {
    return join(outDir, "cfls.exe");
  }
  return join(outDir, `cfls-${target}`);
}

function run(file, args) {
  console.log(`> ${file} ${args.join(" ")}`);
  execFileSync(file, args, { stdio: "inherit", cwd: appDir });
}

function buildSeaBlob(nodeBinary) {
  // The bundle is a CJS-only artifact; SEA does not use the normal ESM build.
  run("pnpm", ["exec", "tsup", "--config", "tsup.exe.config.ts"]);
  if (!existsSync(bundlePath)) {
    fail(`Expected bundle not found: ${bundlePath}`);
  }
  run(nodeBinary, ["--experimental-sea-config", "sea-config.json"]);
  if (!existsSync(blobPath)) {
    fail("SEA blob was not produced.");
  }
}

function injectSeaBlob(basePath, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  copyFileSync(basePath, outputPath);
  try {
    // Pin postject so a future npx default cannot silently change release output.
    run("npx", [
      "--yes",
      "postject@1.0.0-alpha.6",
      outputPath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      SENTINEL,
    ]);
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  }
}

const options = parseCli(process.argv.slice(2));
const target = normalizeTarget(options.get("--target"));
assertSupportedTarget(target);
const outputOption = options.get("--output");
const outputPath =
  outputOption === undefined
    ? defaultOutput(target)
    : isAbsolute(outputOption)
      ? outputOption
      : resolve(process.cwd(), outputOption);
const baseOption = options.get("--node-binary");

const blobGenerator = await resolveOfficialLinuxNode(arch());
buildSeaBlob(blobGenerator);
const basePath =
  target === "win-x64"
    ? await resolveWindowsNodeBase(baseOption)
    : await resolveLinuxNodeBase(target, baseOption);
injectSeaBlob(basePath, outputPath);

if (target.startsWith("linux-")) {
  // `copyFileSync` preserves mode on Linux, but set it explicitly for supplied
  // base files and umasks that do not preserve execute bits.
  const { chmodSync } = await import("node:fs");
  chmodSync(outputPath, 0o755);
}

console.log(`\nBuilt standalone CFLS client: ${outputPath}`);
console.log(
  `Target: ${target}; Node runtime: v${nodeVersion}; size: ${statSync(outputPath).size} bytes`,
);
