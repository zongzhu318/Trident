const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
function createDmg(output, version) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "trident-dmg-"));
  try {
    execFileSync("ditto", [
      path.resolve(output, "mac-arm64/Trident.app"),
      path.join(staging, "Trident.app"),
    ]);
    fs.symlinkSync("/Applications", path.join(staging, "Applications"));
    execFileSync(
      "hdiutil",
      [
        "create",
        "-volname",
        `Trident ${version}`,
        "-srcfolder",
        staging,
        "-format",
        "UDZO",
        "-ov",
        path.resolve(output, `Trident-${version}-arm64.dmg`),
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
module.exports = { createDmg };
if (require.main === module)
  createDmg(
    process.argv[2] || "release",
    require("../../package.json").version,
  );
