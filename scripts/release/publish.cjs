// Called only by the trusted tag workflow. Never print secrets or pass them in argv.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const repo = "zongzhu318/Trident";
const feedURL = "https://zongzhu318.github.io/Trident/stable/appcast-arm64.xml";
const version = require("../../package.json").version;
const tag = process.env.RELEASE_TAG;
const work = path.resolve(".release-work");
const pages = path.join(work, "pages");
const archives = path.join(work, "archives");
const feed = path.join(archives, "appcast-arm64.xml");
const name = `Trident-${version}-arm64.dmg`;
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options });
const gh = (args) => run("gh", [...args, "--repo", repo]);
const validVersion = (value) =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
function compare(a, b) {
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function validateTag() {
  if (!validVersion(version) || tag !== `v${version}`)
    throw new Error("Tag must match package.json stable version");
  if (process.env.GITHUB_REPOSITORY !== repo)
    throw new Error("Unexpected release repository");
  const commit = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]).trim();
  if (commit !== run("git", ["rev-parse", "HEAD"]).trim())
    throw new Error("Checked-out commit does not match release tag");
}
function previousFeed() {
  fs.mkdirSync(archives, { recursive: true });
  const status = run("curl", [
    "-sSL",
    "--retry",
    "3",
    "-w",
    "%{http_code}",
    "-o",
    feed,
    feedURL,
  ]);
  if (status === "404") {
    fs.rmSync(feed, { force: true });
    return;
  }
  if (status !== "200")
    throw new Error(`Cannot read previous feed: HTTP ${status}`);
  // Refuse to turn a temporarily empty/error response into a replacement feed.
  const versions = run("python3", [
    "-c",
    "import sys,xml.etree.ElementTree as E; r=E.parse(sys.argv[1]); print('\\n'.join(e.text for e in r.findall('.//{http://www.andymatuschak.org/xml-namespaces/sparkle}version')))",
    feed,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!versions.length || versions.some((v) => !validVersion(v)))
    throw new Error("Invalid previous feed");
  if (versions.some((v) => compare(v, version) > 0))
    throw new Error("Refusing to roll the update feed backwards");
}
function checkKey() {
  const seed = Buffer.from(
    (process.env.SPARKLE_PRIVATE_KEY || "").trim(),
    "base64",
  );
  if (seed.length !== 32)
    throw new Error(
      "SPARKLE_PRIVATE_KEY must be a new-format 32-byte Sparkle seed (base64)",
    );
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  if (publicKey !== (process.env.SPARKLE_PUBLIC_KEY || "").trim())
    throw new Error("Sparkle public and private keys do not match");
}
function signTool(tool, args) {
  return run(`vendor/sparkle/bin/${tool}`, ["--ed-key-file", "-", ...args], {
    input: process.env.SPARKLE_PRIVATE_KEY.trim() + "\n",
  });
}
function validateFeed(file) {
  const metadata = JSON.parse(
    run("python3", ["scripts/release/validate-feed.py", file, version, name]),
  );
  signTool("sign_update", ["--verify", file]);
  return metadata;
}
async function main() {
  validateTag();
  const mode = process.argv[2];
  if (mode === "preflight") {
    const releases = JSON.parse(
      gh([
        "release",
        "list",
        "--limit",
        "100",
        "--json",
        "tagName,isDraft,isPrerelease",
      ]),
    );
    if (
      releases.some(
        (r) =>
          !r.isDraft &&
          !r.isPrerelease &&
          validVersion(r.tagName.slice(1)) &&
          compare(r.tagName.slice(1), version) > 0,
      )
    )
      throw new Error("A newer stable release is already published");
    const existing = releases.find((r) => r.tagName === tag);
    if (existing?.isDraft)
      throw new Error(
        "A draft exists. Inspect its assets, then delete the draft before retrying; published assets are never overwritten.",
      );
    previousFeed();
    checkKey();
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `reuse=${existing ? "true" : "false"}\n`,
    );
    return;
  }
  if (mode === "publish") {
    checkKey();
    const app = path.resolve("release/mac-arm64/Trident.app");
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const plist = JSON.parse(
      run("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        `${app}/Contents/Info.plist`,
      ]),
    );
    if (
      plist.CFBundleVersion !== version ||
      plist.CFBundleShortVersionString !== version ||
      plist.SUPublicEDKey !== process.env.SPARKLE_PUBLIC_KEY.trim() ||
      plist.SUFeedURL !== feedURL ||
      !plist.SURequireSignedFeed ||
      !plist.SUVerifyUpdateBeforeExtraction
    )
      throw new Error("Packaged updater metadata mismatch");
    fs.mkdirSync(archives, { recursive: true });
    fs.copyFileSync(path.join("release", name), path.join(archives, name));
    fs.copyFileSync(
      "docs/release-notes.md",
      path.join(archives, name.replace(/\.dmg$/, ".md")),
    );
    if (fs.existsSync(feed)) signTool("sign_update", ["--verify", feed]);
    signTool("generate_appcast", [
      "--maximum-deltas",
      "0",
      "--embed-release-notes",
      "--maximum-versions",
      "3",
      "--download-url-prefix",
      `https://github.com/${repo}/releases/download/${tag}/`,
      "-o",
      feed,
      archives,
    ]);
    const metadata = validateFeed(feed);
    if (fs.statSync(path.join(archives, name)).size !== metadata.length)
      throw new Error("Appcast archive length mismatch");
    signTool("sign_update", [
      "--verify",
      path.join(archives, name),
      metadata.signature,
    ]);
    const sums =
      [name, "appcast-arm64.xml"]
        .map(
          (file) =>
            `${crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(archives, file)))
              .digest("hex")}  ${file}`,
        )
        .join("\n") + "\n";
    fs.writeFileSync(path.join(archives, "SHA256SUMS"), sums);
    gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      "--title",
      `Trident ${version}`,
      "--notes-file",
      "docs/release-notes.md",
    ]);
    gh([
      "release",
      "upload",
      tag,
      ...[name, "appcast-arm64.xml", "SHA256SUMS"].map((f) =>
        path.join(archives, f),
      ),
    ]);
    gh(["release", "edit", tag, "--draft=false", "--latest"]);
  } else if (mode === "reuse") {
    gh([
      "release",
      "download",
      tag,
      "--pattern",
      "appcast-arm64.xml",
      "--dir",
      archives,
      "--clobber",
    ]);
    validateFeed(feed);
  } else {
    throw new Error("Expected preflight, publish or reuse");
  }
  // The feed is deployed only after the immutable public archive is reachable.
  run("curl", [
    "--fail",
    "--location",
    "--head",
    "--retry",
    "5",
    "--retry-all-errors",
    `https://github.com/${repo}/releases/download/${tag}/${name}`,
  ]);
  fs.mkdirSync(path.join(pages, "stable"), { recursive: true });
  fs.copyFileSync(feed, path.join(pages, "stable/appcast-arm64.xml"));
  fs.writeFileSync(path.join(pages, ".nojekyll"), "");
  fs.writeFileSync(
    path.join(pages, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>Trident 更新</title><a href="https://github.com/zongzhu318/Trident/releases/latest">下载 Trident for macOS</a>',
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { compare, validVersion, checkKey };
