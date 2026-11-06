import {
  CONTAINER_PROVIDER_LABELS,
  ContainerError,
  type ContainerProviderKind,
  type ContainerProviderStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import type { ContainerCreateInput, ContainerExecOptions } from "./providerTypes.ts";
import { GUEST_HOME, GUEST_PORT, GUEST_RUNTIME } from "./bootstrap.ts";

const Inspection = Schema.Struct({
  Id: Schema.String,
  Config: Schema.Struct({ Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) }),
  State: Schema.Struct({ Running: Schema.Boolean }),
  Mounts: Schema.Array(Schema.Struct({ Source: Schema.String, Destination: Schema.String })),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            HostIp: Schema.String,
            HostPort: Schema.String,
          }),
        ),
      ),
    ),
  }),
});
export type Inspection = typeof Inspection.Type;
const decodeInspections = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Inspection)));
const PROBE_TIMEOUT = "5 seconds";
const STATUS_CACHE_MILLIS = 10_000;
const DETAIL_LIMIT = 200;

const firstLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, DETAIL_LIMIT) ?? null;
const lastLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
    ?.slice(0, DETAIL_LIMIT) ?? null;

export class ContainerEngine extends Context.Service<
  ContainerEngine,
  {
    readonly status: (
      provider: ContainerProviderKind,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<ContainerProviderStatus>;
    readonly inspect: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<Inspection | null, ContainerError>;
    readonly create: (input: ContainerCreateInput) => Effect.Effect<string, ContainerError>;
    readonly start: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly stop: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly remove: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly exec: (
      provider: ContainerProviderKind,
      name: string,
      command: ReadonlyArray<string>,
      options?: ContainerExecOptions,
    ) => Effect.Effect<string, ContainerError>;
  }
>()("t3/containers/engine/ContainerEngine") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const cache = yield* Ref.make(new Map<ContainerProviderKind, ContainerProviderStatus>());
  const execute = Effect.fn("ContainerEngine.execute")(function* (
    provider: ContainerProviderKind,
    stage: string,
    args: ReadonlyArray<string>,
    timeout = "20 minutes",
  ) {
    return yield* runner
      .run({
        command: provider,
        args,
        timeout,
        maxOutputBytes: 512 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) => new ContainerError({ stage, reason: "unavailable", cause })),
      );
  });
  const run = Effect.fn("ContainerEngine.run")(function* (
    provider: ContainerProviderKind,
    stage: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* execute(provider, stage, args);
    if (result.code !== 0) return yield* new ContainerError({ stage, reason: "engine-failed" });
    return result.stdout.trim();
  });
  const inspect = Effect.fn("ContainerEngine.inspect")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    const result = yield* execute(provider, "inspect", ["container", "inspect", name]);
    if (result.code !== 0) {
      yield* run(provider, "engine", ["info"]);
      return null;
    }
    const values = yield* decodeInspections(result.stdout).pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "inspect", reason: "incompatible", cause }),
      ),
    );
    return values[0] ?? null;
  });
  const create = Effect.fn("ContainerEngine.create")(function* (input: ContainerCreateInput) {
    const mounts = [
      ...input.mounts,
      { source: input.homePath, target: GUEST_HOME },
      { source: input.runtimePath, target: GUEST_RUNTIME },
      { source: input.scriptPath, target: "/t3-bootstrap.sh" },
    ];
    return yield* run(input.provider, "create", [
      "create",
      "--name",
      input.name,
      "--init",
      "--label",
      `codes.t3.owner=${input.ownerEnvironmentId}`,
      "--label",
      `codes.t3.workspace=${input.workspaceId}`,
      "--label",
      `codes.t3.operation=${input.operationId}`,
      "--label",
      `codes.t3.revision=${input.revision}`,
      "--publish",
      `127.0.0.1::${GUEST_PORT}`,
      ...mounts.flatMap((mount) => [
        "--mount",
        `type=bind,source=${mount.source},target=${mount.target}${("readonly" in mount && mount.readonly) || mount.target === GUEST_RUNTIME || mount.target === "/t3-bootstrap.sh" ? ",readonly" : ""}`,
      ]),
      "--workdir",
      input.checkoutPath,
      input.image,
      "/bin/bash",
      "/t3-bootstrap.sh",
    ]);
  });
  const start = Effect.fn("ContainerEngine.start")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    yield* run(provider, "start", ["start", name]);
  });
  const stop = Effect.fn("ContainerEngine.stop")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    yield* run(provider, "stop", ["stop", "--time", "30", name]);
  });
  const remove = Effect.fn("ContainerEngine.remove")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    yield* run(provider, "remove", ["rm", name]);
  });
  const exec = Effect.fn("ContainerEngine.exec")(function* (
    provider: ContainerProviderKind,
    name: string,
    command: ReadonlyArray<string>,
    options?: ContainerExecOptions,
  ) {
    return yield* run(provider, "exec", [
      "exec",
      ...(options?.user ? ["--user", options.user] : []),
      ...Object.entries(options?.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      name,
      ...command,
    ]);
  });
  const status = Effect.fn("ContainerEngine.status")(function* (
    provider: ContainerProviderKind,
    options?: { readonly refresh?: boolean },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(cache)).get(provider);
    if (!options?.refresh && cached && now - cached.checkedAt < STATUS_CACHE_MILLIS) return cached;
    const version = yield* execute(provider, "status", ["--version"], PROBE_TIMEOUT).pipe(
      Effect.result,
    );
    const info = yield* execute(provider, "status", ["info"], PROBE_TIMEOUT).pipe(Effect.result);
    const versionLine =
      version._tag === "Success" && version.success.code === 0
        ? firstLine(version.success.stdout)
        : null;
    const available =
      version._tag === "Success" &&
      version.success.code === 0 &&
      info._tag === "Success" &&
      info.success.code === 0;
    const detail = available
      ? null
      : ((info._tag === "Success" ? lastLine(info.success.stderr) : null) ??
        (version._tag === "Success" ? lastLine(version.success.stderr) : null) ??
        `${CONTAINER_PROVIDER_LABELS[provider]} is not installed or is not responding.`);
    const result: ContainerProviderStatus = {
      provider,
      available,
      version: versionLine,
      detail,
      checkedAt: now,
    };
    yield* Ref.update(cache, (entries) => new Map(entries).set(provider, result));
    return result;
  });
  return ContainerEngine.of({
    inspect,
    create,
    start,
    stop,
    remove,
    exec,
    status,
  });
});
export const layer = Layer.effect(ContainerEngine, make);
