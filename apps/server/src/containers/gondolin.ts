import { ContainerError, type ContainerProviderStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeModule from "node:module";
import * as ProcessRunner from "../processRunner.ts";
import { GUEST_HOME, GUEST_PORT, GUEST_RUNTIME } from "./bootstrap.ts";
import type { Inspection } from "./engine.ts";
import type { ContainerCreateInput, ContainerExecOptions } from "./providerTypes.ts";
import type { VirtualProvider } from "@earendil-works/gondolin";

type GondolinModule = typeof import("@earendil-works/gondolin");
type GondolinVm = InstanceType<GondolinModule["VM"]>;
type GondolinIngress = Awaited<ReturnType<GondolinVm["enableIngress"]>>;

const GUEST_STATE = "/t3-state";
const STATUS_CACHE_MILLIS = 10_000;
const PROBE_TIMEOUT = "5 seconds";
const MINIMUM_NODE = [22, 19] as const;
const requireForGondolin = NodeModule.createRequire(import.meta.url);
const PackageJson = Schema.Struct({ version: Schema.String });
const decodePackageJson = Schema.decodeEffect(Schema.fromJsonString(PackageJson));
const GuestManifest = Schema.Struct({
  config: Schema.optionalKey(Schema.Struct({ arch: Schema.optionalKey(Schema.String) })),
  assets: Schema.optionalKey(
    Schema.Struct({
      kernel: Schema.String,
      initramfs: Schema.String,
      rootfs: Schema.String,
    }),
  ),
});
const decodeGuestManifest = Schema.decodeEffect(Schema.fromJsonString(GuestManifest));

const firstLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 200) ?? null;
const lastLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0)
    ?.slice(0, 200) ?? null;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function loadGondolinModule(): Promise<GondolinModule> {
  try {
    return requireForGondolin("@earendil-works/gondolin") as GondolinModule;
  } catch {
    const specifier = "@earendil-works/gondolin";
    return (await import(specifier)) as GondolinModule;
  }
}

function qemuBinary(architecture: NodeJS.Architecture): string {
  return architecture === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

function nodeSupportsGondolin(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((value) => Number(value));
  return major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
}

function guestDirectory(): string | null {
  return (
    process.env.T3CODE_GONDOLIN_GUEST_DIR?.trim() || process.env.GONDOLIN_GUEST_DIR?.trim() || null
  );
}

type Handle = {
  readonly id: string;
  readonly vm: GondolinVm;
  readonly ingress: GondolinIngress;
  readonly labels: Record<string, string>;
  readonly mounts: ReadonlyArray<{ readonly source: string; readonly target: string }>;
};

export class GondolinEngine extends Context.Service<
  GondolinEngine,
  {
    readonly status: (options?: {
      readonly refresh?: boolean;
    }) => Effect.Effect<ContainerProviderStatus>;
    readonly inspect: (name: string) => Effect.Effect<Inspection | null>;
    readonly create: (input: ContainerCreateInput) => Effect.Effect<string, ContainerError>;
    readonly start: (name: string) => Effect.Effect<void, ContainerError>;
    readonly stop: (name: string) => Effect.Effect<void>;
    readonly remove: (name: string) => Effect.Effect<void>;
    readonly exec: (
      name: string,
      command: ReadonlyArray<string>,
      options?: ContainerExecOptions,
    ) => Effect.Effect<string, ContainerError>;
  }
>()("t3/containers/gondolin/GondolinEngine") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const { join } = yield* Path.Path;
  const cache = yield* Ref.make<ContainerProviderStatus | null>(null);
  const loaded = yield* Ref.make<GondolinModule | null>(null);
  const handles = new Map<string, Handle>();

  const loadModule = Effect.fn("GondolinEngine.loadModule")(function* () {
    if (!nodeSupportsGondolin()) {
      return yield* new ContainerError({ stage: "provider", reason: "provider-unavailable" });
    }
    const cached = yield* Ref.get(loaded);
    if (cached) return cached;
    const module = yield* Effect.tryPromise({
      try: () => loadGondolinModule(),
      catch: (cause) =>
        new ContainerError({ stage: "provider", reason: "provider-unavailable", cause }),
    });
    yield* Ref.set(loaded, module);
    return module;
  });

  const packageVersion = Effect.fn("GondolinEngine.packageVersion")(function* () {
    const path = yield* Effect.sync(() => {
      try {
        return requireForGondolin.resolve("@earendil-works/gondolin/package.json");
      } catch {
        return null;
      }
    });
    if (!path) return undefined;
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(decodePackageJson),
      Effect.map((value) => value.version),
      Effect.orElseSucceed(() => undefined),
    );
  });

  const guestAssets = Effect.fn("GondolinEngine.guestAssets")(function* () {
    const directory = guestDirectory();
    if (!directory) {
      return {
        available: false,
        detail: "Set T3CODE_GONDOLIN_GUEST_DIR to the built guest image directory.",
      };
    }
    const manifestPath = join(directory, "manifest.json");
    if (!(yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false)))) {
      return { available: false, detail: "manifest.json is missing from the guest image." };
    }
    const manifest = yield* fs
      .readFileString(manifestPath)
      .pipe(Effect.flatMap(decodeGuestManifest), Effect.option);
    if (Option.isNone(manifest)) {
      return { available: false, detail: "manifest.json cannot be decoded." };
    }
    const expected = architecture === "arm64" ? "aarch64" : "x86_64";
    const actual = manifest.value.config?.arch;
    if (actual !== undefined && actual !== expected) {
      return {
        available: false,
        detail: `Guest image is ${actual}; this host needs ${expected}.`,
      };
    }
    const assets = manifest.value.assets;
    if (!assets) {
      return { available: false, detail: "manifest.json does not list guest assets." };
    }
    for (const [label, filename] of [
      ["kernel", assets.kernel],
      ["initramfs", assets.initramfs],
      ["rootfs", assets.rootfs],
    ] as const) {
      if (!(yield* fs.exists(join(directory, filename)).pipe(Effect.orElseSucceed(() => false)))) {
        return { available: false, detail: `${label} is missing from the guest image.` };
      }
    }
    return { available: true, detail: null };
  });

  const status = Effect.fn("GondolinEngine.status")(function* (options?: {
    readonly refresh?: boolean;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (!options?.refresh && cached && now - cached.checkedAt < STATUS_CACHE_MILLIS) return cached;

    const version = yield* packageVersion();
    const supportedPlatform = platform === "darwin" || platform === "linux";
    const nodeAvailable = nodeSupportsGondolin();
    const moduleAvailable = yield* loadModule().pipe(Effect.result);
    const probe = (command: string) =>
      runner
        .run({
          command,
          args: ["--version"],
          timeout: PROBE_TIMEOUT,
          maxOutputBytes: 16 * 1024,
          outputMode: "truncate",
        })
        .pipe(Effect.result);
    const qemu = yield* probe(qemuBinary(architecture));
    const qemuImg = yield* probe("qemu-img");
    const qemuLine =
      qemu._tag === "Success" && qemu.success.code === 0 ? firstLine(qemu.success.stdout) : null;
    const qemuImgAvailable = qemuImg._tag === "Success" && qemuImg.success.code === 0;
    const qemuDetail =
      qemuLine !== null
        ? null
        : ((qemu._tag === "Success" ? lastLine(qemu.success.stderr) : null) ??
          `Install ${qemuBinary(architecture)} and make sure it is on PATH.`);
    const qemuImgDetail = qemuImgAvailable
      ? null
      : ((qemuImg._tag === "Success" ? lastLine(qemuImg.success.stderr) : null) ??
        "Install qemu-utils and make sure qemu-img is on PATH.");
    const guest = yield* guestAssets();
    const accelerationAvailable =
      supportedPlatform &&
      (platform === "darwin" ||
        (yield* fs.access("/dev/kvm", { readable: true, writable: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )));
    const accelerationLabel = platform === "darwin" ? "HVF acceleration" : "KVM acceleration";
    const accelerationDetail = accelerationAvailable
      ? null
      : platform === "linux"
        ? "KVM is unavailable; QEMU will use software emulation."
        : "Hardware acceleration is unavailable on this host.";
    const requirements = [
      {
        id: "platform",
        label: "macOS or Linux host",
        required: true,
        available: supportedPlatform,
        detail: supportedPlatform ? null : `This host is ${platform}.`,
      },
      {
        id: "node",
        label: `Node.js ${MINIMUM_NODE.join(".")}+`,
        required: true,
        available: nodeAvailable,
        detail: nodeAvailable ? null : `This server runs Node ${process.versions.node}.`,
      },
      {
        id: "sdk",
        label: "Gondolin SDK",
        required: true,
        available: moduleAvailable._tag === "Success",
        detail:
          moduleAvailable._tag === "Success"
            ? null
            : "Install @earendil-works/gondolin on this host.",
      },
      {
        id: "qemu",
        label: `QEMU (${qemuBinary(architecture)})`,
        required: true,
        available: qemuLine !== null,
        detail: qemuDetail,
      },
      {
        id: "qemu-img",
        label: "qemu-img",
        required: true,
        available: qemuImgAvailable,
        detail: qemuImgDetail,
      },
      {
        id: "guest-image",
        label: "Guest image",
        required: true,
        available: guest.available,
        detail: guest.detail,
      },
      {
        id: "acceleration",
        label: accelerationLabel,
        required: false,
        available: accelerationAvailable,
        detail: accelerationDetail,
      },
    ];
    const missing = requirements.filter(
      (requirement) => requirement.required && !requirement.available,
    );
    const available = missing.length === 0;
    const detail = available
      ? null
      : `Missing: ${missing.map((requirement) => requirement.label).join(", ")}.`;
    const result: ContainerProviderStatus = {
      provider: "gondolin",
      available,
      version: version ? `Gondolin ${version}${qemuLine ? ` · ${qemuLine}` : ""}` : qemuLine,
      detail,
      requirements,
      checkedAt: now,
    };
    yield* Ref.set(cache, result);
    return result;
  });

  const inspect = Effect.fn("GondolinEngine.inspect")(function* (name: string) {
    return yield* Effect.sync(() => {
      const handle = handles.get(name);
      if (!handle || handle.vm.getHostPid() === null) return null;
      return {
        Id: handle.id,
        Config: { Labels: handle.labels },
        State: { Running: true },
        Mounts: handle.mounts.map((mount) => ({
          Source: mount.source,
          Destination: mount.target,
        })),
        NetworkSettings: {
          Ports: {
            [`${GUEST_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(handle.ingress.port) }],
          },
        },
      } satisfies Inspection;
    });
  });

  const create = Effect.fn("GondolinEngine.create")(function* (input: ContainerCreateInput) {
    const existing = handles.get(input.name);
    if (existing) return existing.id;
    const module = yield* loadModule();
    const directory = guestDirectory();
    if (!directory) {
      return yield* new ContainerError({ stage: "provider", reason: "provider-unavailable" });
    }
    const mounts: Record<string, VirtualProvider> = {};
    for (const mount of input.mounts) {
      const fileSystemProvider = new module.RealFSProvider(mount.source);
      mounts[mount.target] = mount.readonly
        ? new module.ReadonlyProvider(fileSystemProvider)
        : fileSystemProvider;
    }
    mounts[GUEST_HOME] = new module.RealFSProvider(input.homePath);
    mounts[GUEST_RUNTIME] = new module.ReadonlyProvider(
      new module.RealFSProvider(input.runtimePath),
    );
    mounts[GUEST_STATE] = new module.ReadonlyProvider(new module.RealFSProvider(input.directory));
    const handle = yield* Effect.tryPromise({
      try: async () => {
        const vm = await module.VM.create({
          sessionLabel: `t3 ${input.workspaceId}`,
          sandbox: { imagePath: directory, memory: "2G", cpus: 2 },
          rootfs: { mode: "cow" },
          vfs: { mounts },
          httpHooks: module.createHttpHooks({}).httpHooks,
        });
        try {
          const ingress = await vm.enableIngress({ listenHost: "127.0.0.1", listenPort: 0 });
          vm.setIngressRoutes([{ prefix: "/", port: GUEST_PORT, stripPrefix: false }]);
          const bootstrap = await vm.exec([
            "/bin/bash",
            "-lc",
            [
              "if command -v setsid >/dev/null 2>&1; then",
              `nohup setsid /bin/bash ${GUEST_STATE}/bootstrap.sh </dev/null >${GUEST_HOME}/.t3-bootstrap.log 2>&1 &`,
              "else",
              `nohup /bin/bash ${GUEST_STATE}/bootstrap.sh </dev/null >${GUEST_HOME}/.t3-bootstrap.log 2>&1 &`,
              "fi",
            ].join("\n"),
          ]);
          if (bootstrap.exitCode !== 0) {
            throw new Error(bootstrap.stderr || `bootstrap exited ${bootstrap.exitCode}`);
          }
          return {
            id: vm.id,
            vm,
            ingress,
            labels: {
              "codes.t3.owner": input.ownerEnvironmentId,
              "codes.t3.workspace": input.workspaceId,
              "codes.t3.operation": input.operationId,
              "codes.t3.revision": input.revision,
            },
            mounts: [
              ...input.mounts,
              { source: input.homePath, target: GUEST_HOME },
              { source: input.runtimePath, target: GUEST_RUNTIME },
              { source: input.directory, target: GUEST_STATE },
            ],
          } satisfies Handle;
        } catch (cause) {
          await vm.close().catch(() => {});
          throw cause;
        }
      },
      catch: (cause) => new ContainerError({ stage: "create", reason: "engine-failed", cause }),
    });
    handles.set(input.name, handle);
    return handle.id;
  });

  const start = Effect.fn("GondolinEngine.start")(function* (name: string) {
    if (!handles.has(name)) {
      return yield* new ContainerError({ stage: "start", reason: "guest-failed" });
    }
  });

  const close = Effect.fn("GondolinEngine.close")(function* (name: string) {
    const handle = handles.get(name);
    if (!handle) return;
    handles.delete(name);
    yield* Effect.tryPromise({
      try: async () => {
        await handle.ingress.close().catch(() => {});
        await handle.vm.close().catch(() => {});
      },
      catch: (cause) => new ContainerError({ stage: "stop", reason: "engine-failed", cause }),
    }).pipe(Effect.ignore);
  });

  const exec = Effect.fn("GondolinEngine.exec")(function* (
    name: string,
    command: ReadonlyArray<string>,
    options?: ContainerExecOptions,
  ) {
    const handle = handles.get(name);
    if (!handle) return yield* new ContainerError({ stage: "exec", reason: "guest-failed" });
    const environment = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...options?.env,
    };
    const pairs = Object.entries(environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const prefix = options?.user
      ? `runuser -u ${shellQuote(options.user)} -- env -i ${pairs}`
      : `env -i ${pairs}`;
    const full = `${prefix} ${command.map(shellQuote).join(" ")}`;
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await handle.vm.exec(["/bin/bash", "-lc", full]);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
        }
        return result.stdout.trim();
      },
      catch: (cause) => new ContainerError({ stage: "exec", reason: "engine-failed", cause }),
    });
  });

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const handle of handles.values()) {
        await handle.ingress.close().catch(() => {});
        await handle.vm.close().catch(() => {});
      }
      handles.clear();
    }),
  );

  return GondolinEngine.of({
    status,
    inspect,
    create,
    start,
    stop: close,
    remove: close,
    exec,
  });
});
export const layer = Layer.effect(GondolinEngine, make);
