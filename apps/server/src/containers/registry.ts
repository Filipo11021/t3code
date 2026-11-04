import {
  ContainerConfig,
  ContainerError,
  ContainerOperationId,
  ContainerWorkspace,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

export const WorkspaceRecord = Schema.Struct({
  ...ContainerWorkspace.fields,
  operationId: ContainerOperationId,
  ownerEnvironmentId: EnvironmentId,
  config: ContainerConfig,
  runtimeRevision: Schema.String,
  runtimePath: Schema.String,
  directory: Schema.String,
  mounts: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      target: Schema.String,
      readonly: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  containerId: Schema.NullOr(Schema.String),
  guest: Schema.NullOr(Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId })),
});
export type WorkspaceRecord = typeof WorkspaceRecord.Type;
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(WorkspaceRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecord));
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(ContainerConfig));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(ContainerConfig));

export class ContainerRegistry extends Context.Service<
  ContainerRegistry,
  {
    readonly root: string;
    readonly list: Effect.Effect<ReadonlyArray<WorkspaceRecord>, ContainerError>;
    readonly save: (record: WorkspaceRecord) => Effect.Effect<void, ContainerError>;
    readonly config: Effect.Effect<ContainerConfig | null, ContainerError>;
    readonly setConfig: (config: ContainerConfig) => Effect.Effect<void, ContainerError>;
  }
>()("t3/containers/registry/ContainerRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = join(config.stateDir, "containers");
  const wrap = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "registry", reason: "persistence", cause }),
      ),
    );
  const atomicWrite = Effect.fn("ContainerRegistry.atomicWrite")(
    function* (path: string, text: string) {
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      const temporary = yield* fs.makeTempFileScoped({ directory: root, prefix: ".write-" });
      yield* fs.writeFileString(temporary, text);
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, path);
    },
    Effect.scoped,
    wrap,
  );
  const list = wrap(
    Effect.gen(function* () {
      if (!(yield* fs.exists(root))) return [];
      const files = (yield* fs.readDirectory(root)).filter((file) =>
        file.endsWith(".workspace.json"),
      );
      return yield* Effect.forEach(files, (file) =>
        fs.readFileString(join(root, file)).pipe(Effect.flatMap(decodeRecord)),
      );
    }),
  );
  const readConfig = wrap(
    Effect.gen(function* () {
      const path = join(root, "config.json");
      if (!(yield* fs.exists(path))) return null;
      return yield* decodeConfig(yield* fs.readFileString(path));
    }),
  );
  return ContainerRegistry.of({
    root,
    list,
    config: readConfig,
    save: Effect.fn("ContainerRegistry.save")(function* (record) {
      const text = yield* encodeRecord(record).pipe(wrap);
      yield* atomicWrite(join(root, `${record.id}.workspace.json`), text);
    }),
    setConfig: Effect.fn("ContainerRegistry.setConfig")(function* (value) {
      const text = yield* encodeConfig(value).pipe(wrap);
      yield* atomicWrite(join(root, "config.json"), text);
    }),
  });
});
export const layer = Layer.effect(ContainerRegistry, make);
