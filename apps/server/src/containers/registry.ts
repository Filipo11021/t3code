import {
  ContainerConfig,
  ContainerError,
  ContainerOperationId,
  ContainerWorkspace,
  EnvironmentId,
  ProjectId,
  ContainerSetup,
  ProjectContainerSetupRecord,
  ProjectContainerCleanupRecord,
  ContainerGuestMessage,
  CommandId,
  ThreadId,
  MessageId,
  ContainerRuntimeKind,
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
  config: ContainerSetup,
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
  staleContainers: Schema.Array(
    Schema.Struct({
      runtime: ContainerRuntimeKind,
      containerId: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  guest: Schema.NullOr(Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId })),
});
export type WorkspaceRecord = typeof WorkspaceRecord.Type;
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(WorkspaceRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecord));
const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(ContainerConfig));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(ContainerConfig));
const decodeSetup = Schema.decodeEffect(Schema.fromJsonString(ProjectContainerSetupRecord));
const encodeSetup = Schema.encodeEffect(Schema.fromJsonString(ProjectContainerSetupRecord));
const decodeCleanup = Schema.decodeEffect(Schema.fromJsonString(ProjectContainerCleanupRecord));
const encodeCleanup = Schema.encodeEffect(Schema.fromJsonString(ProjectContainerCleanupRecord));
export const SubmissionRecord = Schema.Struct({
  operationId: ContainerOperationId,
  message: ContainerGuestMessage,
  launch: Schema.Struct({
    commandId: CommandId,
    threadId: ThreadId,
    projectId: ProjectId,
    title: Schema.String,
    generateTitle: Schema.Literal(true),
    modelSelection: ContainerGuestMessage.fields.modelSelection,
    runtimeMode: ContainerGuestMessage.fields.runtimeMode,
    interactionMode: ContainerGuestMessage.fields.interactionMode,
    workspaceStrategy: Schema.Struct({ type: Schema.Literal("root") }),
    initialMessage: Schema.Struct({
      messageId: MessageId,
      text: Schema.String,
      attachments: Schema.Tuple([]),
    }),
    createdBy: Schema.Literal("user"),
    creationSource: Schema.Literal("web"),
  }),
});
export type SubmissionRecord = typeof SubmissionRecord.Type;
const decodeSubmission = Schema.decodeEffect(Schema.fromJsonString(SubmissionRecord));
const encodeSubmission = Schema.encodeEffect(Schema.fromJsonString(SubmissionRecord));

export class ContainerRegistry extends Context.Service<
  ContainerRegistry,
  {
    readonly root: string;
    readonly list: Effect.Effect<ReadonlyArray<WorkspaceRecord>, ContainerError>;
    readonly save: (record: WorkspaceRecord) => Effect.Effect<void, ContainerError>;
    readonly config: Effect.Effect<ContainerConfig | null, ContainerError>;
    readonly setConfig: (config: ContainerConfig) => Effect.Effect<void, ContainerError>;
    readonly submission: (
      id: ContainerOperationId,
    ) => Effect.Effect<SubmissionRecord | null, ContainerError>;
    readonly sealSubmission: (record: SubmissionRecord) => Effect.Effect<void, ContainerError>;
    readonly projectSetup: (
      id: ProjectId,
    ) => Effect.Effect<ProjectContainerSetupRecord | null, ContainerError>;
    readonly projectCleanup: (
      id: ProjectId,
    ) => Effect.Effect<ProjectContainerCleanupRecord | null, ContainerError>;
    readonly setProjectSetup: (
      id: ProjectId,
      value: ProjectContainerSetupRecord,
    ) => Effect.Effect<void, ContainerError>;
    readonly setProjectCleanup: (
      id: ProjectId,
      value: ProjectContainerCleanupRecord,
    ) => Effect.Effect<void, ContainerError>;
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
  const projectPath = (kind: "setup" | "cleanup", id: ProjectId) =>
    join(root, `project-${Buffer.from(id).toString("base64url")}-${kind}.json`);
  const projectSetup = Effect.fn("ContainerRegistry.projectSetup")(function* (id: ProjectId) {
    const path = projectPath("setup", id);
    if (!(yield* fs.exists(path))) return null;
    return yield* decodeSetup(yield* fs.readFileString(path));
  }, wrap);
  const projectCleanup = Effect.fn("ContainerRegistry.projectCleanup")(function* (id: ProjectId) {
    const path = projectPath("cleanup", id);
    if (!(yield* fs.exists(path))) return null;
    return yield* decodeCleanup(yield* fs.readFileString(path));
  }, wrap);
  return ContainerRegistry.of({
    root,
    list,
    config: readConfig,
    submission: Effect.fn("ContainerRegistry.submission")(function* (id) {
      const path = join(root, `submission-${id}.json`);
      if (!(yield* fs.exists(path))) return null;
      return yield* decodeSubmission(yield* fs.readFileString(path));
    }, wrap),
    sealSubmission: Effect.fn("ContainerRegistry.sealSubmission")(function* (record) {
      const text = yield* encodeSubmission(record).pipe(wrap);
      yield* atomicWrite(join(root, `submission-${record.operationId}.json`), text);
    }),
    projectSetup,
    projectCleanup,
    setProjectSetup: Effect.fn("ContainerRegistry.setProjectSetup")(function* (id, value) {
      const text = yield* encodeSetup(value).pipe(wrap);
      yield* atomicWrite(projectPath("setup", id), text);
    }),
    setProjectCleanup: Effect.fn("ContainerRegistry.setProjectCleanup")(function* (id, value) {
      const text = yield* encodeCleanup(value).pipe(wrap);
      yield* atomicWrite(projectPath("cleanup", id), text);
    }),
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
