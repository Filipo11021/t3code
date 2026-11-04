import { ContainerError } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

export class ContainerEngine extends Context.Service<
  ContainerEngine,
  {
    readonly run: (
      stage: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, ContainerError>;
    readonly inspect: (name: string) => Effect.Effect<Inspection | null, ContainerError>;
  }
>()("t3/containers/engine/ContainerEngine") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const binary = yield* Config.String("T3CODE_CONTAINER_ENGINE").pipe(Config.withDefault("docker"));
  const execute = Effect.fn("ContainerEngine.execute")(function* (
    stage: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* runner
      .run({
        command: binary,
        args,
        timeout: "20 minutes",
        maxOutputBytes: 512 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) => new ContainerError({ stage, reason: "unavailable", cause })),
      );
  });
  const run = Effect.fn("ContainerEngine.run")(function* (
    stage: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* execute(stage, args);
    if (result.code !== 0) return yield* new ContainerError({ stage, reason: "engine-failed" });
    return result.stdout.trim();
  });
  const inspect = Effect.fn("ContainerEngine.inspect")(function* (name: string) {
    const result = yield* execute("inspect", ["container", "inspect", name]);
    if (result.code !== 0) {
      // Distinguish a missing object from daemon/permission failures before recreating anything.
      yield* run("engine", ["info", "--format", "{{.ServerVersion}}"]);
      return null;
    }
    const values = yield* decodeInspections(result.stdout).pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "inspect", reason: "incompatible", cause }),
      ),
    );
    return values[0] ?? null;
  });
  return ContainerEngine.of({ run, inspect });
});
export const layer = Layer.effect(ContainerEngine, make);
