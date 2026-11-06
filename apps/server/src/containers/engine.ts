import {
  CONTAINER_RUNTIME_LABELS,
  ContainerError,
  type ContainerRuntimeKind,
  type ContainerRuntimeStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

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

export class ContainerEngine extends Context.Service<
  ContainerEngine,
  {
    readonly run: (
      runtime: ContainerRuntimeKind,
      stage: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, ContainerError>;
    readonly inspect: (
      runtime: ContainerRuntimeKind,
      name: string,
    ) => Effect.Effect<Inspection | null, ContainerError>;
    readonly status: (
      runtime: ContainerRuntimeKind,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<ContainerRuntimeStatus>;
  }
>()("t3/containers/engine/ContainerEngine") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const cache = yield* Ref.make(new Map<ContainerRuntimeKind, ContainerRuntimeStatus>());
  const execute = Effect.fn("ContainerEngine.execute")(function* (
    runtime: ContainerRuntimeKind,
    stage: string,
    args: ReadonlyArray<string>,
    timeout = "20 minutes",
  ) {
    return yield* runner
      .run({
        command: runtime,
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
    runtime: ContainerRuntimeKind,
    stage: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* execute(runtime, stage, args);
    if (result.code !== 0) return yield* new ContainerError({ stage, reason: "engine-failed" });
    return result.stdout.trim();
  });
  const inspect = Effect.fn("ContainerEngine.inspect")(function* (
    runtime: ContainerRuntimeKind,
    name: string,
  ) {
    const result = yield* execute(runtime, "inspect", ["container", "inspect", name]);
    if (result.code !== 0) {
      yield* run(runtime, "engine", ["info", "--format", "{{.ServerVersion}}"]);
      return null;
    }
    const values = yield* decodeInspections(result.stdout).pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "inspect", reason: "incompatible", cause }),
      ),
    );
    return values[0] ?? null;
  });
  const status = Effect.fn("ContainerEngine.status")(function* (
    runtime: ContainerRuntimeKind,
    options?: { readonly refresh?: boolean },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(cache)).get(runtime);
    if (!options?.refresh && cached && now - cached.checkedAt < STATUS_CACHE_MILLIS) return cached;
    const version = yield* execute(runtime, "status", ["--version"], PROBE_TIMEOUT).pipe(
      Effect.result,
    );
    const info = yield* execute(runtime, "status", ["info"], PROBE_TIMEOUT).pipe(Effect.result);
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
      : ((info._tag === "Success" ? firstLine(info.success.stderr) : null) ??
        (version._tag === "Success" ? firstLine(version.success.stderr) : null) ??
        `${CONTAINER_RUNTIME_LABELS[runtime]} is not installed or is not responding.`);
    const result: ContainerRuntimeStatus = {
      runtime,
      available,
      version: versionLine,
      detail,
      checkedAt: now,
    };
    yield* Ref.update(cache, (entries) => new Map(entries).set(runtime, result));
    return result;
  });
  return ContainerEngine.of({ run, inspect, status });
});
export const layer = Layer.effect(ContainerEngine, make);
