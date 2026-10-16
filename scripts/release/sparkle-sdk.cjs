const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const version = "2.10.0";
const sha256 =
  "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c";
const directory = path.join(root, "vendor/sparkle");
const marker = path.join(directory, ".verified-version");
if (
  !fs.existsSync(marker) ||
  fs.readFileSync(marker, "utf8") !== `${version}:${sha256}`
) {
  fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
  const archive = path.join(root, "vendor", `Sparkle-${version}.tar.xz`);
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      `https://github.com/sparkle-project/Sparkle/releases/download/${version}/Sparkle-${version}.tar.xz`,
      "-o",
      archive,
    ],
    { stdio: "inherit" },
  );
  if (
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(archive))
      .digest("hex") !== sha256
  )
    throw new Error("Sparkle SDK checksum mismatch");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  fs.writeFileSync(marker, `${version}:${sha256}`);
}
console.log(`Sparkle ${version} ready: ${directory}`);
