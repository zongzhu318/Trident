const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("First release supports macOS arm64 only");
require("./sparkle-sdk.cjs");
// Only stable Node-API C symbols are used, never V8 or Electron ABI internals.
let include = process.env.NODE_API_HEADERS;
if (!include) {
  const version = process.versions.node;
  const base = path.join(root, "vendor", `node-v${version}`);
  include = path.join(base, "include/node");
  if (!fs.existsSync(path.join(include, "node_api.h"))) {
    const archive = path.join(
      root,
      "vendor",
      `node-v${version}-headers.tar.gz`,
    );
    execFileSync(
      "curl",
      [
        "-fLsS",
        "--retry",
        "3",
        `https://nodejs.org/dist/v${version}/node-v${version}-headers.tar.gz`,
        "-o",
        archive,
      ],
      { stdio: "inherit" },
    );
    execFileSync("tar", ["-xf", archive, "-C", path.join(root, "vendor")]);
  }
}
execFileSync(
  "xcrun",
  [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-fblocks",
    "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=sparkle_bridge",
    "-mmacosx-version-min=12.0",
    "-arch",
    "arm64",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-I",
    include,
    "-F",
    path.join(root, "vendor/sparkle"),
    "-framework",
    "Cocoa",
    "-framework",
    "Sparkle",
    "-Wl,-rpath,@loader_path/../../Frameworks",
    path.join(root, "native/sparkle-bridge/bridge.mm"),
    "-o",
    path.join(root, "native/sparkle-bridge/sparkle-bridge.node"),
  ],
  { stdio: "inherit" },
);
console.log("Built arm64 Sparkle Node-API bridge");
