import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ContainerError,
  ConfigureProjectContainerInput,
  ContainerOperationId,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
  type Project,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ContainerWorkspaces from "./ContainerWorkspaces.ts";
import * as Engine from "./engine.ts";
import * as Runtime from "./bootstrap.ts";
import * as Registry from "./registry.ts";
import * as Guest from "./GuestConnection.ts";

const decodeConfigureProject = Schema.decodeUnknownResult(ConfigureProjectContainerInput);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: "/tmp/opencode",
    prefix: "container-lifecycle-",
  });
  const checkout = path.join(root, "checkout");
  yield* fs.makeDirectory(checkout);
  const hostId = EnvironmentId.make("host");
  const projectId = ProjectId.make("project");
  const now = "2026-11-04T00:00:00.000Z";
  const project: Project = {
    id: projectId,
    title: "Checkout",
    workspaceRoot: checkout,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const commands: Array<ReadonlyArray<string>> = [];
  const projects = new Map([[projectId, project]]);
  let stageHook = Effect.void;
  let idleHook = Effect.void;
  const objects = new Map<string, Engine.Inspection>();
  let busy = false;
  let failure = false;
  let identities = 0;
  const engine = Engine.ContainerEngine.of({
    inspect: (name) => Effect.succeed(objects.get(name) ?? null),
    run: (stage, args) =>
      Effect.sync(() => {
        commands.push(args);
        if (args[0] === "create") {
          const name = args[args.indexOf("--name") + 1]!;
          const id = `container-${objects.size}`;
          const workspaceId = name.slice("t3-workspace-".length);
          objects.set(name, {
            Id: id,
            Config: { Labels: { "codes.t3.owner": hostId, "codes.t3.workspace": workspaceId } },
            State: { Running: false },
            Mounts: args.flatMap((argument, index) => {
              if (args[index - 1] !== "--mount") return [];
              const values = Object.fromEntries(argument.split(",").map((part) => part.split("=")));
              return values.source && values.target
                ? [{ Source: values.source, Destination: values.target }]
                : [];
            }),
            NetworkSettings: { Ports: {} },
          });
          return id;
        }
        const name = args.at(-1)!;
        const object = objects.get(name);
        if (object && stage === "start") objects.set(name, { ...object, State: { Running: true } });
        if (object && stage === "stop") objects.set(name, { ...object, State: { Running: false } });
        if (stage === "remove") objects.delete(name);
        return "";
      }),
  });
  const guest = Guest.GuestConnection.of({
    origin: () => Effect.succeed("http://127.0.0.1:3773"),
    credential: () => Effect.succeed("guest-token"),
    prepare: () =>
      Effect.suspend(() => {
        identities++;
        return failure
          ? Effect.fail(new ContainerError({ stage: "install", reason: "engine-failed" }))
          : Effect.succeed({
              environmentId: EnvironmentId.make("guest"),
              projectId: ProjectId.make("guest-project"),
            });
      }),
    idle: () => idleHook.pipe(Effect.andThen(Effect.sync(() => !busy))),
  });
  const layers = ContainerWorkspaces.layer.pipe(
    Layer.provideMerge(Registry.layer),
    Layer.provide(Layer.succeed(Engine.ContainerEngine, engine)),
    Layer.provide(Layer.succeed(Guest.GuestConnection, guest)),
    Layer.provide(
      Layer.mock(Runtime.ContainerRuntime)({
        stage: (directory) =>
          stageHook.pipe(Effect.as({ path: directory, revision: "bundled-revision" })),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.sync(() => (projects.has(id) ? Option.some(projects.get(id)!) : Option.none())),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: hostId,
          label: "Host",
          serverVersion: "0.1.7",
          platform: { os: "linux", arch: "x64" },
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(ServerConfig.layerTest(checkout, path.join(checkout, ".t3"))),
  );
  const context = yield* Layer.build(layers);
  const service = yield* ContainerWorkspaces.ContainerWorkspaces.pipe(
    Effect.provideContext(context),
  );
  const registry = yield* Registry.ContainerRegistry.pipe(Effect.provideContext(context));
  const input = {
    projectId,
    checkoutPath: checkout,
    operationId: ContainerOperationId.make("operation-one"),
    selection: { type: "fresh" as const },
  };
  return {
    service,
    registry,
    input,
    commands,
    objects,
    projects,
    stage: (hook: Effect.Effect<void>) => {
      stageHook = hook;
    },
    idle: (hook: Effect.Effect<void>) => {
      idleHook = hook;
    },
    busy: (value: boolean) => {
      busy = value;
    },
    fail: (value: boolean) => {
      failure = value;
    },
    identities: () => identities,
  };
});
const confirmedFixture = Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.service.configureProject({
    kind: "setup",
    projectId: f.input.projectId,
    expectedRevision: null,
    value: DEFAULT_CONTAINER_CONFIG,
  });
  const setup = (yield* f.service.settings({ projectId: f.input.projectId })).project!.setup!;
  return { ...f, input: { ...f.input, setupRevision: setup.revision } };
});

it.effect(
  "requires explicit project confirmation, pins setup revisions and reuses the recorded checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        (yield* f.service.settings({ projectId: f.input.projectId })).project?.setup,
      ).toBeNull();
      expect(yield* f.service.open(f.input).pipe(Effect.flip)).toMatchObject({
        reason: "setup-required",
      });
      expect(f.commands).toEqual([]);
      yield* f.service.configureProject({
        kind: "setup",
        projectId: f.input.projectId,
        expectedRevision: null,
        value: DEFAULT_CONTAINER_CONFIG,
      });
      const confirmed = (yield* f.service.settings({ projectId: f.input.projectId })).project!
        .setup!;
      expect(confirmed.value.installScript).toBe("");
      const input = { ...f.input, setupRevision: confirmed.revision };
      yield* f.service.configureProject({
        kind: "setup",
        projectId: f.input.projectId,
        expectedRevision: confirmed.revision,
        value: { ...confirmed.value, installScript: "changed" },
      });
      expect(yield* f.service.open(input).pipe(Effect.flip)).toMatchObject({
        reason: "configuration-conflict",
      });
      const current = (yield* f.service.settings({ projectId: f.input.projectId })).project!.setup!;
      yield* f.service.open({ ...input, setupRevision: current.revision });
      yield* f.service.configureProject({
        kind: "setup",
        projectId: f.input.projectId,
        expectedRevision: current.revision,
        value: confirmed.value,
      });
      yield* f.service.open({ ...input, setupRevision: current.revision });
      expect((yield* f.registry.list)[0]?.config.installScript).toBe("changed");
      yield* f.service.open({
        ...f.input,
        checkoutPath: "/not-the-recorded-checkout",
        selection: {
          type: "existing",
          workspaceId: ContainerWorkspaceId.make(f.input.operationId),
        },
      });
      expect(f.commands.filter((args) => args[0] === "create")).toHaveLength(1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "captures setup before runtime staging without blocking project edits and isolates project records",
  () =>
    Effect.gen(function* () {
      const f = yield* confirmedFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.stage(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))));
      const opening = yield* f.service.open(f.input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.service.configureProject({
        kind: "setup",
        projectId: f.input.projectId,
        expectedRevision: f.input.setupRevision,
        value: { ...DEFAULT_CONTAINER_CONFIG, startScript: "new" },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(opening);
      expect((yield* f.registry.list)[0]?.config.startScript).toBe("");
      const otherId = ProjectId.make("other/project");
      f.projects.set(otherId, { ...f.projects.get(f.input.projectId)!, id: otherId });
      expect((yield* f.service.settings({ projectId: otherId })).project?.setup).toBeNull();
      expect(
        yield* f.service
          .open({
            ...f.input,
            projectId: otherId,
            operationId: ContainerOperationId.make("other-operation"),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "setup-required" });
      expect(
        yield* f.service
          .configureProject({
            kind: "setup",
            projectId: f.input.projectId,
            expectedRevision: f.input.setupRevision,
            value: DEFAULT_CONTAINER_CONFIG,
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "configuration-conflict" });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "uses live recorded-project cleanup and retains leased, orphaned and unsafe legacy-policy runtimes",
  () =>
    Effect.gen(function* () {
      const f = yield* confirmedFixture;
      const destination = yield* f.service.open(f.input);
      const record = (yield* f.registry.list)[0]!;
      yield* f.registry.save({ ...record, lastUsedAt: -2 * 86_400_000 });
      yield* f.service.configure({
        ...DEFAULT_CONTAINER_CONFIG,
        cleanup: { idleStopMinutes: 1, removeAfterDays: 1 },
      });
      yield* f.service.configureProject({
        kind: "cleanup",
        projectId: f.input.projectId,
        expectedRevision: null,
        value: { kind: "off" },
      });
      yield* f.service.cleanup;
      expect(f.objects.size).toBe(1);
      const cleanup = (yield* f.service.settings({ projectId: f.input.projectId })).project!
        .cleanup!;
      yield* f.service.configureProject({
        kind: "cleanup",
        projectId: f.input.projectId,
        expectedRevision: cleanup.revision,
        value: { kind: "inherit" },
      });
      const leaseScope = yield* Scope.make();
      yield* f.service
        .route(destination.workspaceId)
        .pipe(Effect.provideService(Scope.Scope, leaseScope));
      yield* f.service.cleanup;
      expect(f.objects.size).toBe(1);
      yield* Scope.close(leaseScope, Exit.void);
      yield* f.registry.save({ ...record, lastUsedAt: -2 * 86_400_000 });
      const project = f.projects.get(f.input.projectId)!;
      f.projects.delete(f.input.projectId);
      yield* f.service.cleanup;
      expect(f.objects.size).toBe(1);
      f.projects.set(f.input.projectId, project);
      yield* f.registry.setConfig({
        ...DEFAULT_CONTAINER_CONFIG,
        cleanup: { idleStopMinutes: 525601, removeAfterDays: 3651 },
      });
      yield* f.service.cleanup;
      expect(f.objects.size).toBe(1);
      yield* f.service.configure({
        ...DEFAULT_CONTAINER_CONFIG,
        cleanup: { idleStopMinutes: 1, removeAfterDays: 1 },
      });
      const inherited = (yield* f.service.settings({ projectId: f.input.projectId })).project!
        .cleanup!;
      f.idle(
        f.service
          .configureProject({
            kind: "cleanup",
            projectId: f.input.projectId,
            expectedRevision: inherited.revision,
            value: { kind: "off" },
          })
          .pipe(Effect.orDie),
      );
      yield* f.service.cleanup;
      expect(f.objects.size).toBe(1);
      expect(f.commands.filter((args) => args[0] === "stop")).toHaveLength(0);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rejects new cleanup writes outside product bounds and accepts the upper limits", () =>
  Effect.gen(function* () {
    const f = yield* confirmedFixture;
    expect(
      (yield* f.service
        .configure({
          ...DEFAULT_CONTAINER_CONFIG,
          cleanup: { idleStopMinutes: 525601, removeAfterDays: null },
        })
        .pipe(Effect.flip)).reason,
    ).toBe("incompatible");
    expect(
      (yield* f.service
        .configure({
          ...DEFAULT_CONTAINER_CONFIG,
          cleanup: { idleStopMinutes: null, removeAfterDays: 3651 },
        })
        .pipe(Effect.flip)).reason,
    ).toBe("incompatible");
    yield* f.service.configure({
      ...DEFAULT_CONTAINER_CONFIG,
      cleanup: { idleStopMinutes: 525600, removeAfterDays: 3650 },
    });
    const outOfRange: unknown = {
      kind: "cleanup",
      projectId: f.input.projectId,
      expectedRevision: null,
      value: { kind: "custom", rules: { idleStopMinutes: 525601, removeAfterDays: null } },
    };
    expect(decodeConfigureProject(outOfRange)._tag).toBe("Failure");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "converges concurrent/retried opens, reuses stopped guests and retains history after runtime removal",
  () =>
    Effect.gen(function* () {
      const f = yield* confirmedFixture;
      const destinations = yield* Effect.all([f.service.open(f.input), f.service.open(f.input)], {
        concurrency: "unbounded",
      });
      expect(destinations[0]).toEqual(destinations[1]);
      expect(f.commands.filter((args) => args[0] === "create")).toHaveLength(1);
      const workspaceId = ContainerWorkspaceId.make(f.input.operationId);
      f.busy(true);
      expect(
        (yield* f.service.act({ workspaceId, action: "remove-runtime" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(f.objects.size).toBe(1);
      f.busy(false);
      const fs = yield* FileSystem.FileSystem;
      const initial = (yield* f.registry.list)[0]!;
      const marker = `${initial.directory}/home/.installed-${initial.runtimeRevision}`;
      yield* fs.writeFileString(marker, "success");
      yield* fs.writeFileString(`${initial.directory}/home/history-sentinel`, "retained");
      yield* f.service.act({ workspaceId, action: "stop" });
      const reused = yield* f.service.open({
        ...f.input,
        selection: { type: "existing", workspaceId },
      });
      expect(reused).toEqual(destinations[0]);
      expect(f.commands.filter((args) => args[0] === "create")).toHaveLength(1);
      expect(yield* fs.exists(marker)).toBe(true);
      const removed = yield* f.service.act({ workspaceId, action: "remove-runtime" });
      expect(removed.status).toEqual({ type: "removed", retainedData: true });
      const before = (yield* f.registry.list)[0]!;
      expect(
        before.mounts.some(
          (mount) => mount.target === `${f.input.checkoutPath}/.t3` && mount.readonly === true,
        ),
      ).toBe(true);
      expect(yield* (yield* FileSystem.FileSystem).exists(`${before.directory}/home`)).toBe(true);
      const recreated = yield* f.service.open({
        ...f.input,
        selection: { type: "existing", workspaceId },
      });
      expect(recreated.guestEnvironmentId).toBe(destinations[0]?.guestEnvironmentId);
      expect(yield* fs.exists(marker)).toBe(false);
      expect(yield* fs.readFileString(`${initial.directory}/home/history-sentinel`)).toBe(
        "retained",
      );
      expect((yield* f.registry.list)[0]?.config).toEqual(
        (yield* f.service.settings({ projectId: f.input.projectId })).project!.setup!.value,
      );
      expect(f.commands.filter((args) => args[0] === "create")).toHaveLength(2);
      yield* f.service.configure({
        ...DEFAULT_CONTAINER_CONFIG,
        cleanup: { idleStopMinutes: 1, removeAfterDays: 1 },
      });
      const inactive = { ...(yield* f.registry.list)[0]!, lastUsedAt: -2 * 86_400_000 };
      yield* f.registry.save(inactive);
      f.busy(true);
      yield* f.service.cleanup;
      expect((yield* f.registry.list)[0]?.status.type).toBe("ready");
      f.busy(false);
      yield* f.service.cleanup;
      expect((yield* f.registry.list)[0]?.status.type).toBe("removed");
      expect(yield* (yield* FileSystem.FileSystem).exists(`${inactive.directory}/home`)).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "preserves failed installation for explicit retry, snapshots config and refuses external ownership or replaced objects",
  () =>
    Effect.gen(function* () {
      const f = yield* confirmedFixture;
      f.fail(true);
      expect((yield* f.service.open(f.input).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* f.registry.list)[0]?.status.type).toBe("failed");
      f.fail(false);
      yield* f.service.configure({
        ...DEFAULT_CONTAINER_CONFIG,
        installScript: "new installations only",
      });
      yield* f.service.open(f.input);
      let record = (yield* f.registry.list)[0]!;
      expect(record.config.installScript).toBe("");
      expect(f.commands.filter((args) => args[0] === "create")).toHaveLength(1);
      yield* f.registry.save({ ...record, ownership: "attached" });
      expect(
        (yield* f.service
          .act({ workspaceId: record.id, action: "remove-runtime" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      record = { ...record, ownership: "managed", containerId: "someone-else" };
      yield* f.registry.save(record);
      expect((yield* f.service.open(f.input).pipe(Effect.result))._tag).toBe("Failure");
      expect(f.objects.size).toBe(1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
