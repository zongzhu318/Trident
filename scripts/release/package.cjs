const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const key = (process.env.SPARKLE_PUBLIC_KEY || "").trim();
if (
  !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
  Buffer.from(key, "base64").length !== 32
)
  throw new Error(
    "Set SPARKLE_PUBLIC_KEY to the public key from Sparkle generate_keys",
  );
process.env.SPARKLE_PUBLIC_KEY = key;
require("./build-bridge.cjs");
const version = require("../../package.json").version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  throw new Error("Stable release requires x.y.z version");
const config = {
  ...require("../../package.json").build,
  ...(process.env.TRIDENT_RELEASE_OUTPUT
    ? { directories: { output: process.env.TRIDENT_RELEASE_OUTPUT } }
    : {}),
  afterPack: "./build/after-pack.cjs",
  artifactName: "Trident-${version}-${arch}.${ext}",
  buildVersion: version,
  mac: {
    ...require("../../package.json").build.mac,
    target: [{ target: "dir", arch: ["arm64"] }],
    identity: "-",
    hardenedRuntime: false,
    minimumSystemVersion: "12.0",
    extendInfo: {
      SUFeedURL:
        "https://zongzhu318.github.io/Trident/stable/appcast-arm64.xml",
      SUPublicEDKey: key,
      SUEnableAutomaticChecks: false,
      SUAllowsAutomaticUpdates: false,
      SUAutomaticallyUpdate: false,
      SUVerifyUpdateBeforeExtraction: true,
      SURequireSignedFeed: true,
    },
  },
  dmg: { sign: false },
};
fs.writeFileSync("build/sparkle-config.json", JSON.stringify(config, null, 2));
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
execFileSync(
  "node_modules/.bin/electron-builder",
  [
    "--config",
    "build/sparkle-config.json",
    "--mac",
    "--arm64",
    "--publish",
    "never",
    ...(process.env.TRIDENT_LOCAL_ELECTRON
      ? ["--config.electronDist=node_modules/electron/dist"]
      : []),
  ],
  { stdio: "inherit" },
);
require("./create-dmg.cjs").createDmg(config.directories.output, version);
