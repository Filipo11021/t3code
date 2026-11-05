import { ContainerError, type ContainerConfig } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import { telemetryChannel } from "../config.ts";
import packageJson from "../../package.json" with { type: "json" };

export const GUEST_PORT = 3773;
export const GUEST_HOME = "/home/t3";
export const GUEST_RUNTIME = "/opt/t3";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const protectedVariables =
  /^(HOME|USER|LOGNAME|PATH|SHELL|LD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|T3CODE_.*)$/;
const isContainerError = Schema.is(ContainerError);
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      platform: Schema.Literal("linux"),
      arch: Schema.Literals(["x64", "arm64"]),
      sha256: Schema.String,
    }),
  ),
);

export function guestEnvironment(config: ContainerConfig): ReadonlyArray<string> {
  if (Object.keys(config.environment).some((key) => protectedVariables.test(key))) {
    throw new ContainerError({ stage: "environment", reason: "invalid-environment" });
  }
  return Object.entries(config.environment).map(([key, value]) => `${key}=${value}`);
}

export function bootstrapScript(input: {
  readonly uid: number;
  readonly gid: number;
  readonly checkout: string;
  readonly revision: string;
  readonly config: ContainerConfig;
}): string {
  const environment = guestEnvironment(input.config).map(quote).join(" ");
  const userCommand = (command: string) =>
    `runuser -u t3 -- env -i HOME=${GUEST_HOME} USER=t3 LOGNAME=t3 SHELL=/bin/bash PATH=/opt/t3:/home/t3/.local/bin:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 T3CODE_CONTAINER_GUEST=1 ${environment} /bin/bash -c ${quote(command)}`;
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "if [ ! -f /var/lib/t3-bootstrap-ready ]; then",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates git curl bash util-linux libatomic1 libstdc++6 procps nodejs npm python3",
    "touch /var/lib/t3-bootstrap-ready",
    "fi",
    `existing=$(getent passwd ${input.uid} | cut -d: -f1 || true)`,
    'if [ -n "$existing" ] && [ "$existing" != t3 ]; then usermod -l t3 "$existing"; fi',
    `getent group ${input.gid} >/dev/null || groupadd -g ${input.gid} t3`,
    `id t3 >/dev/null 2>&1 || useradd -M -u ${input.uid} -g ${input.gid} -d ${GUEST_HOME} -s /bin/bash t3`,
    `usermod -d ${GUEST_HOME} -g ${input.gid} -s /bin/bash t3`,
    `chown ${input.uid}:${input.gid} ${GUEST_HOME}`,
    `cd ${quote(input.checkout)}`,
    userCommand("git config --global --add safe.directory " + quote(input.checkout)),
    `if [ ! -f ${GUEST_HOME}/.installed-${input.revision} ]; then`,
    userCommand(`cd ${quote(input.checkout)}\n${input.config.installScript || ":"}`),
    userCommand(`touch ${GUEST_HOME}/.installed-${input.revision}`),
    "fi",
    userCommand(`cd ${quote(input.checkout)}\n${input.config.startScript || ":"}`),
    `exec ${userCommand(`cd ${quote(input.checkout)}\nexec ${GUEST_RUNTIME}/t3 --base-dir ${GUEST_HOME}/.t3 --host 0.0.0.0 --port ${GUEST_PORT} --no-browser`)}`,
    "",
  ].join("\n");
}

export class ContainerRuntime extends Context.Service<
  ContainerRuntime,
  {
    readonly stage: (
      directory: string,
    ) => Effect.Effect<{ readonly path: string; readonly revision: string }, ContainerError>;
  }
>()("t3/containers/bootstrap/ContainerRuntime") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { dirname, join } = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const runner = yield* ProcessRunner.ProcessRunner;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const override = yield* Config.String("T3CODE_CONTAINER_RUNTIME").pipe(Config.option);
  const stage = Effect.fn("ContainerRuntime.stage")(function* (directory: string) {
    let source = Option.getOrElse(override, () => dirname(process.execPath));
    const result = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true });
      if (
        Option.isNone(override) &&
        (platform !== "linux" || !(yield* fs.exists(join(source, "t3-runtime.json"))))
      ) {
        if (telemetryChannel === "dev" || !["x64", "arm64"].includes(arch))
          return yield* new ContainerError({ stage: "runtime", reason: "runtime-required" });
        const archive = join(directory, `t3-${packageJson.version}-linux-${arch}.tar.gz`);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const response = yield* http.execute(
              HttpClientRequest.get(
                `https://github.com/pingdotgg/t3code/releases/download/v${packageJson.version}/t3-${packageJson.version}-linux-${arch}.tar.gz`,
              ),
            );
            if (response.status !== 200)
              return yield* new ContainerError({
                stage: "runtime-download",
                reason: "runtime-required",
              });
            yield* response.stream.pipe(Stream.run(fs.sink(archive, { mode: 0o600 })));
          }),
        );
        source = archive;
      }
      const stat = yield* fs.stat(source);
      const target = join(directory, "runtime");
      if (!(yield* fs.exists(target))) {
        const temporary = join(directory, "runtime-staging");
        yield* fs.makeDirectory(temporary, { recursive: true });
        if (stat.type === "Directory") {
          for (const item of [
            "t3",
            "client",
            "resource-monitor",
            "node_modules",
            "lib",
            "t3-runtime.json",
          ]) {
            if (yield* fs.exists(join(source, item)))
              yield* fs.copy(join(source, item), join(temporary, item));
          }
        } else {
          const extracted = yield* runner.run({
            command: "tar",
            args: ["-xzf", source, "--strip-components=1", "-C", temporary],
          });
          if (extracted.code !== 0)
            return yield* new ContainerError({ stage: "runtime", reason: "runtime-required" });
        }
        for (const item of [
          "t3",
          "client/index.html",
          "resource-monitor",
          "node_modules/node-pty/package.json",
        ]) {
          if (!(yield* fs.exists(join(temporary, item))))
            return yield* new ContainerError({ stage: "runtime", reason: "runtime-required" });
        }
        yield* fs.chmod(join(temporary, "t3"), 0o755);
        const manifest = yield* decodeManifest(
          yield* fs.readFileString(join(temporary, "t3-runtime.json")),
        );
        const checksum = yield* digest.digestHex(
          Digest.sha256,
          yield* fs.readFile(join(temporary, "t3")),
        );
        if (
          manifest.version !== packageJson.version ||
          manifest.arch !== arch ||
          manifest.sha256 !== checksum
        ) {
          return yield* new ContainerError({
            stage: "runtime-version",
            reason: "runtime-required",
          });
        }
        yield* fs.rename(temporary, target);
      }
      const revision = yield* digest.digestHex(
        Digest.sha256,
        yield* fs.readFile(join(target, "t3")),
      );
      return { path: target, revision };
    }).pipe(
      Effect.mapError((cause) =>
        isContainerError(cause)
          ? cause
          : new ContainerError({ stage: "runtime", reason: "runtime-required", cause }),
      ),
    );
    return result;
  });
  return ContainerRuntime.of({ stage });
});
export const layer = Layer.effect(ContainerRuntime, make);
