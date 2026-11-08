import {
  CONTAINER_RUNTIME_KINDS,
  ContainerError,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  type ContainerActionInput,
  type ChangeContainerRuntimeInput,
  ContainerConfig,
  ContainerSetup,
  ContainerConfigurationRevision,
  ContainerCleanupRules,
  ContainerConfigWrite,
  ConfigureProjectContainerInput,
  type ContainerRuntimeKind,
  type ProjectId,
  type ContainerDestination,
  type ContainerListInput,
  type ContainerSettings,
  type ContainerWorkspace,
  type OpenContainerInput,
  type WakeContainerInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import { forkParked } from "../serverActivation.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContainerEngine from "./engine.ts";
import * as ContainerRuntime from "./bootstrap.ts";
import * as ContainerRegistry from "./registry.ts";
import * as GuestConnection from "./GuestConnection.ts";

type WorkspaceRecord = ContainerRegistry.WorkspaceRecord;
const isContainerError = Schema.is(ContainerError);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(ContainerSetup));
const decodeConfigWrite = Schema.decodeEffect(ContainerConfigWrite);
const decodeConfigureProject = Schema.decodeEffect(ConfigureProjectContainerInput);
const validCleanup = Schema.is(ContainerCleanupRules);
export class ContainerWorkspaces extends Context.Service<
  ContainerWorkspaces,
  {
    readonly open: (
      input: OpenContainerInput,
    ) => Effect.Effect<ContainerDestination, ContainerError>;
    readonly settings: (
      input: typeof ContainerListInput.Type,
    ) => Effect.Effect<ContainerSettings, ContainerError>;
    readonly configure: (config: ContainerConfig) => Effect.Effect<void, ContainerError>;
    readonly configureProject: (
      input: ConfigureProjectContainerInput,
    ) => Effect.Effect<typeof ContainerConfigurationRevision.Type, ContainerError>;
    readonly act: (
      input: ContainerActionInput,
      options?: { readonly automatic?: boolean; readonly ignoreLeases?: boolean },
    ) => Effect.Effect<ContainerWorkspace, ContainerError>;
    readonly wake: (
      input: WakeContainerInput,
    ) => Effect.Effect<ContainerDestination, ContainerError>;
    readonly idle: Effect.Effect<void, ContainerError>;
    readonly changeRuntime: (
      input: ChangeContainerRuntimeInput,
    ) => Effect.Effect<ContainerDestination, ContainerError>;
    readonly cleanup: Effect.Effect<void, ContainerError>;
    readonly route: (id: ContainerWorkspaceId) => Effect.Effect<
      {
        readonly record: WorkspaceRecord;
        readonly closed: Effect.Effect<void>;
      },
      ContainerError,
      Scope.Scope
    >;
  }
>()("t3/containers/ContainerWorkspaces") {}

const asWorkspace = (record: WorkspaceRecord): ContainerWorkspace => ({
  id: record.id,
  ownership: record.ownership,
  projectId: record.projectId,
  checkoutPath: record.checkoutPath,
  image: record.image,
  runtime: record.runtime,
  status: record.status,
  lastUsedAt: record.lastUsedAt,
});

const make = Effect.gen(function* () {
  const registry = yield* ContainerRegistry.ContainerRegistry;
  const engine = yield* ContainerEngine.ContainerEngine;
  const runtime = yield* ContainerRuntime.ContainerRuntime;
  const guests = yield* GuestConnection.GuestConnection;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const hostConfig = yield* ServerConfig.ServerConfig;
  const hostHome = yield* HostProcess.HomeDirectory;
  const { basename, isAbsolute, join, relative } = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const within = (root: string, path: string) => {
    const suffix = relative(root, path);
    return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
  };
  const runner = yield* ProcessRunner.ProcessRunner;
  const locks = yield* KeyedLock.make<string>();
  const guestMode = yield* Config.String("T3CODE_CONTAINER_GUEST").pipe(Config.withDefault("0"));
  const owner = (yield* environment.getDescriptor).environmentId;
  const blocked = new Set<ContainerWorkspaceId>();
  const leases = new Map<
    ContainerWorkspaceId,
    { count: number; close: Deferred.Deferred<void>; drained: Deferred.Deferred<void> }
  >();
  const fail = (stage: string, reason: ContainerError["reason"]) =>
    new ContainerError({ stage, reason });
  const runtimeSettings = Effect.fn("ContainerWorkspaces.runtimeSettings")(function* (
    projectId: ProjectId | null,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "settings", reason: "persistence", cause }),
      ),
    );
    return {
      default: settings.containerRuntime,
      project:
        projectId === null
          ? null
          : (settings.projectSettingsOverrides[projectId]?.containerRuntime ?? null),
      resolved: resolveProjectSettings(settings, projectId).settings.containerRuntime,
    };
  });
  const guard = guestMode === "1" ? Effect.fail(fail("host", "disabled")) : Effect.void;
  const find = Effect.fn("ContainerWorkspaces.find")(function* (id: ContainerWorkspaceId) {
    const record = (yield* registry.list).find(
      (entry) => entry.id === id && entry.ownerEnvironmentId === owner,
    );
    if (!record) return yield* fail("registry", "not-found");
    return record;
  });
  const mountsFor = Effect.fn("ContainerWorkspaces.mountsFor")(function* (
    input: { readonly projectId: ProjectId; readonly checkoutPath: string },
    workspaceId: ContainerWorkspaceId,
  ) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ContainerError({ stage: "project", reason: "invalid-checkout", cause }),
        ),
      );
    if (Option.isNone(project)) return yield* fail("project", "invalid-checkout");
    return yield* Effect.gen(function* () {
      const checkout = yield* fs.realPath(input.checkoutPath);
      const root = yield* fs.realPath(project.value.workspaceRoot);
      if (
        !isAbsolute(checkout) ||
        checkout === "/" ||
        /[,\n\r\0]/.test(checkout) ||
        within(registry.root, checkout) ||
        within(checkout, hostHome)
      )
        return yield* fail("checkout", "invalid-checkout");
      const gitCommon = (path: string) =>
        runner.run({
          command: "git",
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          cwd: path,
        });
      const checkoutGit = yield* gitCommon(checkout);
      if (checkout !== root) {
        const rootGit = yield* gitCommon(root);
        if (
          checkoutGit.code !== 0 ||
          rootGit.code !== 0 ||
          (yield* fs.realPath(checkoutGit.stdout.trim())) !==
            (yield* fs.realPath(rootGit.stdout.trim()))
        )
          return yield* fail("checkout", "invalid-checkout");
      }
      const mounts: Array<WorkspaceRecord["mounts"][number]> = [
        { source: checkout, target: checkout },
      ];
      const stateDirectory = yield* fs.realPath(hostConfig.baseDir);
      if (within(checkout, stateDirectory))
        mounts.push({
          source: join(registry.root, workspaceId, "host-state-mask"),
          target: stateDirectory,
          readonly: true,
        });
      if (checkoutGit.code === 0) {
        const common = yield* fs.realPath(checkoutGit.stdout.trim());
        if (common === "/" || /[,\n\r\0]/.test(common))
          return yield* fail("git-metadata", "invalid-checkout");
        if (!within(checkout, common)) mounts.push({ source: common, target: common });
      }
      return { checkout, mounts };
    }).pipe(
      Effect.mapError((cause) =>
        isContainerError(cause)
          ? cause
          : new ContainerError({ stage: "mounts", reason: "invalid-checkout", cause }),
      ),
    );
  });
  const ensure = Effect.fn("ContainerWorkspaces.ensure")(function* (
    original: WorkspaceRecord,
    options?: { readonly preserveInstallMarker?: boolean },
  ) {
    let record = original;
    try {
      if (record.ownership !== "managed") return yield* fail("start", "not-owned");
      const runtimeStatus = yield* engine.status(record.runtime);
      if (!runtimeStatus.available) return yield* fail("start", "runtime-unavailable");
      let inspected = yield* engine.inspect(
        record.runtime,
        GuestConnection.containerName(record.id),
      );
      if (inspected) {
        if (
          inspected.Config.Labels?.["codes.t3.owner"] !== owner ||
          inspected.Config.Labels["codes.t3.workspace"] !== record.id ||
          (record.containerId !== null && record.containerId !== inspected.Id) ||
          !record.mounts.every((mount) =>
            inspected!.Mounts.some(
              (actual) => actual.Source === mount.source && actual.Destination === mount.target,
            ),
          )
        )
          return yield* fail("identity", "incompatible");
      } else {
        const home = join(record.directory, "home");
        for (const mount of record.mounts)
          if (mount.readonly)
            yield* fs
              .makeDirectory(mount.source, { recursive: true })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ContainerError({ stage: "state-mask", reason: "persistence", cause }),
                ),
              );
        yield* fs
          .makeDirectory(home, { recursive: true, mode: 0o700 })
          .pipe(
            Effect.mapError(
              (cause) => new ContainerError({ stage: "home", reason: "persistence", cause }),
            ),
          );
        const script = join(record.directory, "bootstrap.sh");
        if (options?.preserveInstallMarker !== true)
          yield* fs
            .remove(join(home, `.installed-${record.runtimeRevision}`), { force: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ContainerError({ stage: "install-marker", reason: "persistence", cause }),
              ),
            );
        yield* fs
          .writeFileString(
            script,
            ContainerRuntime.bootstrapScript({
              uid: process.getuid?.() || 1000,
              gid: process.getgid?.() || 1000,
              checkout: record.checkoutPath,
              revision: record.runtimeRevision,
              config: record.config,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) => new ContainerError({ stage: "bootstrap", reason: "persistence", cause }),
            ),
          );
        const mounts = [
          ...record.mounts,
          { source: home, target: ContainerRuntime.GUEST_HOME },
          { source: record.runtimePath, target: ContainerRuntime.GUEST_RUNTIME },
          { source: script, target: "/t3-bootstrap.sh" },
        ];
        const id = yield* engine.run(record.runtime, "create", [
          "create",
          "--name",
          GuestConnection.containerName(record.id),
          "--init",
          "--label",
          `codes.t3.owner=${owner}`,
          "--label",
          `codes.t3.workspace=${record.id}`,
          "--label",
          `codes.t3.operation=${record.operationId}`,
          "--label",
          `codes.t3.revision=${record.runtimeRevision}`,
          "--publish",
          `127.0.0.1::${ContainerRuntime.GUEST_PORT}`,
          ...mounts.flatMap((mount) => [
            "--mount",
            `type=bind,source=${mount.source},target=${mount.target}${("readonly" in mount && mount.readonly) || mount.target === ContainerRuntime.GUEST_RUNTIME || mount.target === "/t3-bootstrap.sh" ? ",readonly" : ""}`,
          ]),
          "--workdir",
          record.checkoutPath,
          record.image,
          "/bin/bash",
          "/t3-bootstrap.sh",
        ]);
        record = { ...record, containerId: id, status: { type: "provisioning", stage: "start" } };
        yield* registry.save(record);
        inspected = yield* engine.inspect(record.runtime, GuestConnection.containerName(record.id));
      }
      if (!inspected?.State.Running)
        yield* engine.run(record.runtime, "start", [
          "start",
          GuestConnection.containerName(record.id),
        ]);
      const guest = yield* guests.prepare(record);
      const destination: ContainerDestination = {
        hostEnvironmentId: owner,
        workspaceId: record.id,
        guestEnvironmentId: guest.environmentId,
        guestProjectId: guest.projectId,
        guestCheckoutPath: record.checkoutPath,
        runtime: record.runtime,
        label: `${basename(record.checkoutPath)} · ${record.image}`,
      };
      record = {
        ...record,
        guest,
        status: { type: "ready", destination },
        lastUsedAt: yield* Clock.currentTimeMillis,
      };
      yield* registry.save(record);
      return destination;
    } finally {
      blocked.delete(record.id);
    }
  });
  const open = Effect.fn("ContainerWorkspaces.open")(function* (input: OpenContainerInput) {
    yield* guard;
    const id =
      input.selection.type === "existing"
        ? input.selection.workspaceId
        : ContainerWorkspaceId.make(input.operationId);
    return yield* locks.withLock(
      id,
      Effect.gen(function* () {
        let record = (yield* registry.list).find((entry) => entry.id === id);
        if (record && (record.ownerEnvironmentId !== owner || record.projectId !== input.projectId))
          return yield* fail("reuse", "incompatible");
        const mounted = yield* mountsFor(
          {
            projectId: input.projectId,
            checkoutPath:
              input.selection.type === "existing" && record
                ? record.checkoutPath
                : input.checkoutPath,
          },
          id,
        );
        if (record) {
          if (record.checkoutPath !== mounted.checkout) return yield* fail("reuse", "incompatible");
          const runtimeStatus = yield* engine.status(record.runtime, { refresh: true });
          if (!runtimeStatus.available) return yield* fail("runtime", "runtime-unavailable");
        } else {
          if (input.selection.type !== "fresh") return yield* fail("reuse", "not-found");
          const selectedRuntime = (yield* runtimeSettings(input.projectId)).resolved;
          const runtimeStatus = yield* engine.status(selectedRuntime, { refresh: true });
          if (!runtimeStatus.available) return yield* fail("runtime", "runtime-unavailable");
          const config = yield* locks.withLock(
            `project-setup:${input.projectId}`,
            Effect.gen(function* () {
              const setup = yield* registry.projectSetup(input.projectId);
              if (!setup || !input.setupRevision) return yield* fail("setup", "setup-required");
              if (setup.revision !== input.setupRevision)
                return yield* fail("setup", "configuration-conflict");
              return setup.value;
            }),
          );
          const directory = join(registry.root, id);
          const artifact = yield* runtime.stage(directory);
          const encoded = yield* encodeConfig(config).pipe(
            Effect.mapError(
              (cause) =>
                new ContainerError({ stage: "configuration", reason: "persistence", cause }),
            ),
          );
          const revision = yield* digest.digestHex(
            Digest.sha256,
            new TextEncoder().encode(artifact.revision + encoded),
          );
          record = {
            id,
            operationId: input.operationId,
            ownerEnvironmentId: owner,
            ownership: "managed",
            projectId: input.projectId,
            checkoutPath: mounted.checkout,
            image: config.image,
            config,
            runtimeRevision: revision,
            runtimePath: artifact.path,
            directory,
            mounts: mounted.mounts,
            containerId: null,
            runtime: selectedRuntime,
            staleContainers: [],
            guest: null,
            lastUsedAt: yield* Clock.currentTimeMillis,
            status: { type: "provisioning", stage: "create" },
          };
          yield* registry.save(record);
        }
        const current = record;
        return yield* ensure(current).pipe(
          Effect.tapError((error) =>
            registry.save({
              ...current,
              status: { type: "failed", stage: error.stage, error: error.message },
            }),
          ),
        );
      }),
    );
  });
  const act = Effect.fn("ContainerWorkspaces.act")(function* (
    input: ContainerActionInput,
    options?: { readonly automatic?: boolean; readonly ignoreLeases?: boolean },
  ) {
    yield* guard;
    return yield* locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        let record = yield* find(input.workspaceId);
        if (record.ownership !== "managed") return yield* fail(input.action, "not-owned");
        const runtimeStatus = yield* engine.status(record.runtime);
        if (!runtimeStatus.available) return yield* fail(input.action, "runtime-unavailable");
        if (
          options?.automatic &&
          ((options.ignoreLeases !== true && leases.has(record.id)) ||
            !(yield* cleanupEligible(record, input.action, options)))
        )
          return asWorkspace(record);
        blocked.add(record.id);
        return yield* Effect.gen(function* () {
          const lease = leases.get(record.id);
          if (lease) {
            yield* Deferred.succeed(lease.close, undefined);
            yield* Deferred.await(lease.drained);
          }
          const inspected = yield* engine.inspect(
            record.runtime,
            GuestConnection.containerName(record.id),
          );
          if (inspected) {
            if (
              inspected.Config.Labels?.["codes.t3.owner"] !== owner ||
              inspected.Config.Labels["codes.t3.workspace"] !== record.id ||
              (record.containerId !== null && record.containerId !== inspected.Id)
            )
              return yield* fail("identity", "incompatible");
            if (inspected.State.Running) {
              if (!(yield* guests.idle(record))) return yield* fail("idle", "busy");
              if (options?.automatic && !(yield* cleanupEligible(record, input.action, options)))
                return asWorkspace(record);
              yield* engine.run(record.runtime, "stop", [
                "stop",
                "--time",
                "30",
                GuestConnection.containerName(record.id),
              ]);
            }
            if (options?.automatic && !(yield* cleanupEligible(record, input.action, options)))
              return asWorkspace(record);
            if (input.action === "remove-runtime")
              yield* engine.run(record.runtime, "remove", [
                "rm",
                GuestConnection.containerName(record.id),
              ]);
          }
          record = {
            ...record,
            status:
              input.action === "remove-runtime"
                ? { type: "removed", retainedData: true }
                : { type: "stopped" },
            ...(input.action === "remove-runtime" ? { containerId: null } : {}),
          };
          yield* registry.save(record);
          if (input.action === "restart") {
            yield* ensure(record);
            record = yield* find(record.id);
          }
          return asWorkspace(record);
        }).pipe(Effect.ensuring(Effect.sync(() => blocked.delete(record.id))));
      }),
    );
  });
  const wake = Effect.fn("ContainerWorkspaces.wake")(function* (input: WakeContainerInput) {
    yield* guard;
    return yield* locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        const record = yield* find(input.workspaceId);
        if (record.ownership !== "managed") return yield* fail("wake", "not-owned");
        return yield* ensure(record);
      }),
    );
  });
  const removeContainer = Effect.fn("ContainerWorkspaces.removeContainer")(function* (
    record: WorkspaceRecord,
    runtime: ContainerRuntimeKind,
    containerId: string | null,
  ) {
    const name = GuestConnection.containerName(record.id);
    const inspected = yield* engine.inspect(runtime, name);
    if (!inspected) return;
    if (
      inspected.Config.Labels?.["codes.t3.owner"] !== owner ||
      inspected.Config.Labels["codes.t3.workspace"] !== record.id ||
      (containerId !== null && containerId !== inspected.Id)
    )
      return yield* fail("identity", "incompatible");
    if (inspected.State.Running) {
      const idle = yield* guests.idle(record).pipe(Effect.option);
      if (Option.isSome(idle) && idle.value === false) return yield* fail("change-runtime", "busy");
      yield* engine.run(runtime, "stop", ["stop", "--time", "30", name]);
    }
    yield* engine.run(runtime, "remove", ["rm", name]);
  });
  const changeRuntime = Effect.fn("ContainerWorkspaces.changeRuntime")(function* (
    input: ChangeContainerRuntimeInput,
  ) {
    yield* guard;
    return yield* locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        let record = yield* find(input.workspaceId);
        if (record.ownership !== "managed") return yield* fail("change-runtime", "not-owned");
        if (record.runtime === input.runtime)
          return yield* ensure(record, { preserveInstallMarker: true });
        const targetStatus = yield* engine.status(input.runtime, { refresh: true });
        if (!targetStatus.available) return yield* fail("change-runtime", "runtime-unavailable");
        let staleContainers = record.staleContainers.filter(
          (entry) => entry.runtime !== input.runtime,
        );
        const name = GuestConnection.containerName(record.id);
        const existing = yield* engine.inspect(input.runtime, name);
        if (existing) {
          if (
            existing.Config.Labels?.["codes.t3.owner"] !== owner ||
            existing.Config.Labels["codes.t3.workspace"] !== record.id
          )
            return yield* fail("identity", "incompatible");
          if (existing.State.Running)
            yield* engine.run(input.runtime, "stop", ["stop", "--time", "30", name]);
          yield* engine.run(input.runtime, "remove", ["rm", name]);
        }
        const oldRuntime = record.runtime;
        const oldStatus = yield* engine.status(oldRuntime, { refresh: true });
        if (oldStatus.available) {
          yield* removeContainer(record, oldRuntime, record.containerId);
        } else if (record.containerId !== null) {
          staleContainers = [
            ...staleContainers,
            { runtime: oldRuntime, containerId: record.containerId },
          ];
        }
        record = {
          ...record,
          runtime: input.runtime,
          containerId: null,
          staleContainers,
          status: { type: "provisioning", stage: "change-runtime" },
        };
        yield* registry.save(record);
        return yield* ensure(record, { preserveInstallMarker: true }).pipe(
          Effect.tapError((error) =>
            registry.save({
              ...record,
              status: { type: "failed", stage: error.stage, error: error.message },
            }),
          ),
        );
      }),
    );
  });
  const cleanupStale = Effect.fn("ContainerWorkspaces.cleanupStale")(function* (
    record: WorkspaceRecord,
  ) {
    if (record.staleContainers.length === 0) return record;
    const remaining: Array<WorkspaceRecord["staleContainers"][number]> = [];
    for (const entry of record.staleContainers) {
      // A stale entry naming the live runtime must not remove its current container.
      if (entry.runtime === record.runtime) continue;
      const status = yield* engine.status(entry.runtime);
      if (!status.available) {
        remaining.push(entry);
        continue;
      }
      const name = GuestConnection.containerName(record.id);
      const inspected = yield* engine.inspect(entry.runtime, name).pipe(Effect.result);
      if (inspected._tag === "Failure") {
        remaining.push(entry);
        continue;
      }
      if (!inspected.success) continue;
      if (
        inspected.success.Id !== entry.containerId ||
        inspected.success.Config.Labels?.["codes.t3.owner"] !== owner ||
        inspected.success.Config.Labels["codes.t3.workspace"] !== record.id
      )
        continue;
      if (inspected.success.State.Running)
        yield* engine.run(entry.runtime, "stop", ["stop", "--time", "30", name]);
      yield* engine.run(entry.runtime, "remove", ["rm", name]);
    }
    if (remaining.length === record.staleContainers.length) return record;
    const next = { ...record, staleContainers: remaining };
    yield* registry.save(next);
    return next;
  });
  const settings = Effect.fn("ContainerWorkspaces.settings")(function* (
    input: typeof ContainerListInput.Type,
  ) {
    const records = yield* registry.list;
    return {
      config: (yield* registry.config) ?? DEFAULT_CONTAINER_CONFIG,
      runtime: yield* runtimeSettings(input.projectId ?? null),
      runtimes: yield* Effect.forEach(
        CONTAINER_RUNTIME_KINDS,
        (runtime) => engine.status(runtime, { refresh: input.refreshRuntimes === true }),
        { concurrency: "unbounded" },
      ),
      available: guestMode !== "1",
      ...(input.projectId === undefined
        ? {}
        : {
            project: {
              projectId: input.projectId,
              setup: yield* registry.projectSetup(input.projectId),
              cleanup: yield* registry.projectCleanup(input.projectId),
            },
          }),
      workspaces: records
        .filter(
          (record) =>
            record.ownerEnvironmentId === owner &&
            (input.projectId === undefined || record.projectId === input.projectId) &&
            (input.checkoutPath === undefined || record.checkoutPath === input.checkoutPath),
        )
        .map(asWorkspace),
    };
  });
  const configure = Effect.fn("ContainerWorkspaces.configure")(function* (config: ContainerConfig) {
    yield* guard;
    yield* decodeConfigWrite(config).pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "cleanup", reason: "incompatible", cause }),
      ),
    );
    yield* Effect.try({
      try: () => ContainerRuntime.guestEnvironment(config),
      catch: (cause) =>
        new ContainerError({ stage: "environment", reason: "invalid-environment", cause }),
    });
    yield* locks.withLock("configuration", registry.setConfig(config));
  });
  const configureProject = Effect.fn("ContainerWorkspaces.configureProject")(function* (
    input: ConfigureProjectContainerInput,
  ) {
    yield* guard;
    const decoded = yield* decodeConfigureProject(input).pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "configuration", reason: "incompatible", cause }),
      ),
    );
    const project = yield* projects
      .getById(decoded.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ContainerError({ stage: "project", reason: "not-found", cause }),
        ),
      );
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* fail("project", "not-found");
    return yield* locks.withLock(
      `project-${decoded.kind}:${decoded.projectId}`,
      Effect.gen(function* () {
        const current =
          decoded.kind === "setup"
            ? yield* registry.projectSetup(decoded.projectId)
            : yield* registry.projectCleanup(decoded.projectId);
        if ((current?.revision ?? null) !== decoded.expectedRevision)
          return yield* fail("configuration", "configuration-conflict");
        const revision = ContainerConfigurationRevision.make(yield* random.uuidV4());
        if (decoded.kind === "setup") {
          yield* Effect.try({
            try: () => ContainerRuntime.guestEnvironment(decoded.value),
            catch: (cause) =>
              new ContainerError({ stage: "environment", reason: "invalid-environment", cause }),
          });
          yield* registry.setProjectSetup(decoded.projectId, { revision, value: decoded.value });
        } else {
          yield* registry.setProjectCleanup(decoded.projectId, { revision, value: decoded.value });
        }
        return revision;
      }),
    );
  });
  const route = Effect.fn("ContainerWorkspaces.route")(function* (id: ContainerWorkspaceId) {
    yield* guard;
    return yield* locks.withLock(
      id,
      Effect.gen(function* () {
        const record = yield* find(id);
        if (blocked.has(id) || record.status.type !== "ready")
          return yield* fail("route", "guest-failed");
        const lease = leases.get(id) ?? {
          count: 0,
          close: yield* Deferred.make<void>(),
          drained: yield* Deferred.make<void>(),
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            lease.count++;
            leases.set(id, lease);
          }),
          () =>
            Effect.gen(function* () {
              lease.count--;
              if (lease.count === 0) {
                leases.delete(id);
                yield* Deferred.succeed(lease.drained, undefined);
              }
            }),
        );
        const now = yield* Clock.currentTimeMillis;
        if (now - record.lastUsedAt >= 60_000) yield* registry.save({ ...record, lastUsedAt: now });
        return { record, closed: Deferred.await(lease.close) };
      }),
    );
  });
  const cleanupRulesFor = Effect.fn("ContainerWorkspaces.cleanupRulesFor")(function* (
    record: WorkspaceRecord,
  ) {
    const project = yield* projects.getById(record.projectId).pipe(Effect.result);
    if (
      project._tag === "Failure" ||
      Option.isNone(project.success) ||
      project.success.value.deletedAt !== null
    )
      return null;
    const override = yield* registry.projectCleanup(record.projectId).pipe(Effect.result);
    if (override._tag === "Failure") return null;
    const policy = override.success;
    if (policy?.value.kind === "off") return null;
    const host = yield* registry.config.pipe(Effect.result);
    if (host._tag === "Failure") return null;
    const rules: ContainerCleanupRules =
      policy?.value.kind === "custom"
        ? policy.value.rules
        : (host.success ?? DEFAULT_CONTAINER_CONFIG).cleanup;
    if (!validCleanup(rules)) return null;
    return rules;
  });
  const cleanupEligible = Effect.fn("ContainerWorkspaces.cleanupEligible")(function* (
    record: WorkspaceRecord,
    action: ContainerActionInput["action"],
    options?: { readonly ignoreLeases?: boolean },
  ) {
    if (options?.ignoreLeases !== true && leases.has(record.id)) return false;
    const rules = yield* cleanupRulesFor(record);
    if (rules === null) return false;
    const retention = action === "remove-runtime" ? rules.removeAfterDays : rules.idleStopMinutes;
    if (retention === null) return false;
    return (
      (yield* Clock.currentTimeMillis) - record.lastUsedAt >=
      retention * (action === "remove-runtime" ? 86_400_000 : 60_000)
    );
  });
  const touch = Effect.fn("ContainerWorkspaces.touch")(function* (id: ContainerWorkspaceId) {
    return yield* locks.withLock(
      id,
      Effect.gen(function* () {
        const record = yield* find(id);
        if (record.status.type !== "ready") return;
        yield* registry.save({ ...record, lastUsedAt: yield* Clock.currentTimeMillis });
      }),
    );
  });
  const cleanup = Effect.gen(function* () {
    yield* guard;
    for (const record of yield* registry.list) {
      if (
        record.ownership !== "managed" ||
        record.ownerEnvironmentId !== owner ||
        leases.has(record.id)
      )
        continue;
      yield* cleanupStale(record).pipe(Effect.ignore);
      const remove = yield* cleanupEligible(record, "remove-runtime");
      const stop = yield* cleanupEligible(record, "stop");
      if (
        (remove && record.status.type !== "removed") ||
        (stop && record.status.type === "ready")
      ) {
        yield* act(
          { workspaceId: record.id, action: remove ? "remove-runtime" : "stop" },
          { automatic: true },
        ).pipe(Effect.ignore);
      }
    }
  });
  const idle = Effect.gen(function* () {
    yield* guard;
    for (const record of yield* registry.list) {
      if (record.ownership !== "managed" || record.ownerEnvironmentId !== owner) continue;
      if (record.status.type !== "ready") continue;
      const rules = yield* cleanupRulesFor(record);
      if (rules === null || rules.idleStopMinutes === null) continue;
      const now = yield* Clock.currentTimeMillis;
      const guestIdle = yield* guests.idle(record).pipe(Effect.option);
      if (Option.isNone(guestIdle)) continue;
      if (!guestIdle.value) {
        yield* touch(record.id).pipe(Effect.ignore);
        continue;
      }
      if (now - record.lastUsedAt < rules.idleStopMinutes * 60_000) continue;
      yield* act(
        { workspaceId: record.id, action: "stop" },
        { automatic: true, ignoreLeases: true },
      ).pipe(Effect.ignore);
    }
  });
  if (guestMode !== "1")
    yield* forkParked(cleanup.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("5 minutes"))));
  if (guestMode !== "1")
    yield* forkParked(idle.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("30 seconds"))));
  return ContainerWorkspaces.of({
    open,
    act,
    wake,
    idle,
    changeRuntime,
    settings,
    configure,
    configureProject,
    route,
    cleanup,
  });
});
export const layer = Layer.effect(ContainerWorkspaces, make);
