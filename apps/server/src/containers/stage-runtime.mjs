#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const output = NodePath.resolve(process.argv[2] ?? "/tmp/opencode/t3-container-runtime");
const arch = HostProcess.Architecture.defaultValue();
if (HostProcess.Platform.defaultValue() !== "linux" || !["arm64", "x64"].includes(arch))
  throw new Error("Build this runtime on Linux x64 or arm64.");
function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PATH: `${NodeOS.homedir()}/.cargo/bin:${process.env.PATH}` },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
run("vp", ["run", "--filter", "t3", "build"]);
run("node", [
  "apps/server/scripts/cli.ts",
  "build-exe",
  ...(arch === "x64" ? ["--target", "linux-x64"] : []),
]);
run("vp", ["run", "build:resource-monitor"]);
const monitor = NodePath.resolve(output, "resource-monitor");
NodeFS.mkdirSync(monitor, { recursive: true });
NodeFS.copyFileSync(
  NodePath.resolve(root, "native/resource-monitor/target/release/t3-resource-monitor"),
  NodePath.resolve(monitor, "t3-resource-monitor"),
);
run("node", [
  "scripts/build-cli-archive.ts",
  "--platform",
  "linux",
  "--arch",
  arch,
  "--version",
  packageJson.version,
  "--output-dir",
  output,
  "--resource-monitor-dir",
  monitor,
]);
console.log(
  `T3CODE_CONTAINER_RUNTIME=${NodePath.resolve(output, `t3-${packageJson.version}-linux-${arch}.tar.gz`)}`,
);
