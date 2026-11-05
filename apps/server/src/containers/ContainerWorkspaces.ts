import {
  ContainerError,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  type ContainerActionInput,
  ContainerConfig,
  type ContainerDestination,
  type ContainerListInput,
  type ContainerSettings,
  type ContainerWorkspace,
  type OpenContainerInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
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
import * as ContainerEngine from "./engine.ts";
import * as ContainerRuntime from "./bootstrap.ts";
import * as ContainerRegistry from "./registry.ts";
import * as GuestConnection from "./GuestConnection.ts";

type WorkspaceRecord = ContainerRegistry.WorkspaceRecord;
const isContainerError = Schema.is(ContainerError);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(ContainerConfig));
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
    readonly act: (
      input: ContainerActionInput,
    ) => Effect.Effect<ContainerWorkspace, ContainerError>;
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
  const fs = yield* FileSystem.FileSystem;
  const hostConfig = yield* ServerConfig.ServerConfig;
  const hostHome = yield* HostProcess.HomeDirectory;
  const { basename, isAbsolute, join, relative } = yield* Path.Path;
  const digest = yield* Digest.Digest;
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
  const guard = guestMode === "1" ? Effect.fail(fail("host", "disabled")) : Effect.void;
  const find = Effect.fn("ContainerWorkspaces.find")(function* (id: ContainerWorkspaceId) {
    const record = (yield* registry.list).find(
      (entry) => entry.id === id && entry.ownerEnvironmentId === owner,
    );
    if (!record) return yield* fail("registry", "not-found");
    return record;
  });
  const mountsFor = Effect.fn("ContainerWorkspaces.mountsFor")(function* (
    input: OpenContainerInput,
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
  const ensure = Effect.fn("ContainerWorkspaces.ensure")(function* (original: WorkspaceRecord) {
    let record = original;
    try {
      if (record.ownership !== "managed") return yield* fail("start", "not-owned");
      let inspected = yield* engine.inspect(GuestConnection.containerName(record.id));
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
        const id = yield* engine.run("create", [
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
        inspected = yield* engine.inspect(GuestConnection.containerName(record.id));
      }
      if (!inspected?.State.Running)
        yield* engine.run("start", ["start", GuestConnection.containerName(record.id)]);
      const guest = yield* guests.prepare(record);
      const destination: ContainerDestination = {
        hostEnvironmentId: owner,
        workspaceId: record.id,
        guestEnvironmentId: guest.environmentId,
        guestProjectId: guest.projectId,
        guestCheckoutPath: record.checkoutPath,
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
        const mounted = yield* mountsFor(input, id);
        let record = (yield* registry.list).find((entry) => entry.id === id);
        if (record) {
          if (
            record.ownerEnvironmentId !== owner ||
            record.projectId !== input.projectId ||
            record.checkoutPath !== mounted.checkout
          )
            return yield* fail("reuse", "incompatible");
        } else {
          if (input.selection.type !== "fresh") return yield* fail("reuse", "not-found");
          const config = (yield* registry.config) ?? DEFAULT_CONTAINER_CONFIG;
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
    inactiveBefore?: number,
  ) {
    yield* guard;
    return yield* locks.withLock(
      input.workspaceId,
      Effect.gen(function* () {
        let record = yield* find(input.workspaceId);
        if (record.ownership !== "managed") return yield* fail(input.action, "not-owned");
        if (
          inactiveBefore !== undefined &&
          (record.lastUsedAt > inactiveBefore || leases.has(record.id))
        )
          return asWorkspace(record);
        blocked.add(record.id);
        return yield* Effect.gen(function* () {
          const lease = leases.get(record.id);
          if (lease) {
            yield* Deferred.succeed(lease.close, undefined);
            yield* Deferred.await(lease.drained);
          }
          const inspected = yield* engine.inspect(GuestConnection.containerName(record.id));
          if (inspected) {
            if (
              inspected.Config.Labels?.["codes.t3.owner"] !== owner ||
              inspected.Config.Labels["codes.t3.workspace"] !== record.id ||
              (record.containerId !== null && record.containerId !== inspected.Id)
            )
              return yield* fail("identity", "incompatible");
            if (inspected.State.Running) {
              if (!(yield* guests.idle(record))) return yield* fail("idle", "busy");
              yield* engine.run("stop", [
                "stop",
                "--time",
                "30",
                GuestConnection.containerName(record.id),
              ]);
            }
            if (input.action === "remove-runtime")
              yield* engine.run("remove", ["rm", GuestConnection.containerName(record.id)]);
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
  const settings = Effect.fn("ContainerWorkspaces.settings")(function* (
    input: typeof ContainerListInput.Type,
  ) {
    const records = yield* registry.list;
    return {
      config: (yield* registry.config) ?? DEFAULT_CONTAINER_CONFIG,
      available: guestMode !== "1",
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
    yield* Effect.try({
      try: () => ContainerRuntime.guestEnvironment(config),
      catch: (cause) =>
        new ContainerError({ stage: "environment", reason: "invalid-environment", cause }),
    });
    yield* locks.withLock("configuration", registry.setConfig(config));
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
  const cleanup = Effect.gen(function* () {
    yield* guard;
    const config = (yield* registry.config) ?? DEFAULT_CONTAINER_CONFIG;
    const now = yield* Clock.currentTimeMillis;
    for (const record of yield* registry.list) {
      if (
        record.ownership !== "managed" ||
        record.ownerEnvironmentId !== owner ||
        leases.has(record.id)
      )
        continue;
      const idleMs = now - record.lastUsedAt;
      const remove =
        config.cleanup.removeAfterDays !== null &&
        idleMs >= config.cleanup.removeAfterDays * 86_400_000;
      const stop =
        config.cleanup.idleStopMinutes !== null &&
        idleMs >= config.cleanup.idleStopMinutes * 60_000;
      if (
        (remove && record.status.type !== "removed") ||
        (stop && record.status.type === "ready")
      ) {
        const retention = remove
          ? (config.cleanup.removeAfterDays ?? Infinity) * 86_400_000
          : (config.cleanup.idleStopMinutes ?? Infinity) * 60_000;
        yield* act(
          { workspaceId: record.id, action: remove ? "remove-runtime" : "stop" },
          now - retention,
        ).pipe(Effect.ignore);
      }
    }
  });
  if (guestMode !== "1")
    yield* forkParked(cleanup.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("5 minutes"))));
  return ContainerWorkspaces.of({ open, act, settings, configure, route, cleanup });
});
export const layer = Layer.effect(ContainerWorkspaces, make);
