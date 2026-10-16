const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
module.exports = async (context) => {
  if (!process.env.SPARKLE_PUBLIC_KEY) return;
  const contents = path.join(context.appOutDir, "Trident.app/Contents");
  if (context.electronPlatformName !== "darwin")
    throw new Error("Sparkle is macOS only");
  execFileSync("ditto", [
    path.resolve("vendor/sparkle/Sparkle.framework"),
    path.join(contents, "Frameworks/Sparkle.framework"),
  ]);
  const target = path.join(contents, "Resources/sparkle");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    "native/sparkle-bridge/sparkle-bridge.node",
    path.join(target, "sparkle-bridge.node"),
  );
  fs.writeFileSync(
    path.join(target, "config.json"),
    JSON.stringify({ enabled: true }),
  );
  // Preserve Sparkle's bundled licenses in the distributed application.
  fs.copyFileSync(
    "vendor/sparkle/LICENSE",
    path.join(target, "Sparkle-LICENSE"),
  );
};
