import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as Gondolin from "./gondolin.ts";

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const layerWith = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Gondolin.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
    Layer.provideMerge(NodeServices.layer),
  );

const withGuestDirectory = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectory({
        directory: "/tmp/opencode",
        prefix: "gondolin-status-",
      });
      yield* fs.writeFileString(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          version: 1,
          config: { arch: "x86_64" },
          assets: {
            kernel: "vmlinuz-virt",
            initramfs: "initramfs.cpio.lz4",
            rootfs: "rootfs.ext4",
          },
        }),
      );
      for (const file of ["vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"]) {
        yield* fs.writeFileString(path.join(directory, file), "");
      }
      const previous = process.env.T3CODE_GONDOLIN_GUEST_DIR;
      process.env.T3CODE_GONDOLIN_GUEST_DIR = directory;
      return { previous, directory };
    }),
    () => effect,
    ({ previous, directory }) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_GONDOLIN_GUEST_DIR;
          else process.env.T3CODE_GONDOLIN_GUEST_DIR = previous;
        });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
      }),
  );

it.effect("reports Gondolin available when the SDK, QEMU and guest image exist", () =>
  Effect.gen(function* () {
    const engine = yield* Gondolin.GondolinEngine.pipe(
      Effect.provide(
        layerWith(() => Effect.succeed(output({ stdout: "QEMU emulator version 9.0.0\n" }))),
      ),
    );
    const status = yield* withGuestDirectory(engine.status());
    expect(status).toMatchObject({
      provider: "gondolin",
      available: true,
      detail: null,
    });
    expect(status.version).toContain("Gondolin");
    expect(status.version).toContain("QEMU emulator version 9.0.0");
    expect(status.requirements.filter((requirement) => requirement.required)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "qemu", available: true }),
        expect.objectContaining({ id: "qemu-img", available: true }),
        expect.objectContaining({ id: "guest-image", available: true }),
      ]),
    );
    expect(
      status.requirements.find((requirement) => requirement.id === "acceleration"),
    ).toMatchObject({ required: false });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports the missing guest image instead of a generic failure", () =>
  Effect.gen(function* () {
    const engine = yield* Gondolin.GondolinEngine.pipe(
      Effect.provide(
        layerWith(() => Effect.succeed(output({ stdout: "QEMU emulator version 9.0.0\n" }))),
      ),
    );
    const previous = process.env.T3CODE_GONDOLIN_GUEST_DIR;
    delete process.env.T3CODE_GONDOLIN_GUEST_DIR;
    const status = yield* engine.status().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous !== undefined) process.env.T3CODE_GONDOLIN_GUEST_DIR = previous;
        }),
      ),
    );
    expect(status.available).toBe(false);
    expect(status.detail).toContain("Guest image");
    expect(
      status.requirements.find((requirement) => requirement.id === "guest-image")?.detail,
    ).toContain("T3CODE_GONDOLIN_GUEST_DIR");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports QEMU when the guest image exists but the binary does not", () =>
  Effect.gen(function* () {
    const engine = yield* Gondolin.GondolinEngine.pipe(
      Effect.provide(
        layerWith(() =>
          Effect.succeed(
            output({
              stderr: "qemu-system-x86_64: not found",
              code: ChildProcessSpawner.ExitCode(1),
            }),
          ),
        ),
      ),
    );
    const status = yield* withGuestDirectory(engine.status());
    expect(status.available).toBe(false);
    expect(status.detail).toContain("QEMU");
    expect(status.requirements.find((requirement) => requirement.id === "qemu")).toMatchObject({
      available: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports qemu-img when the QEMU system binary works but qemu-img does not", () =>
  Effect.gen(function* () {
    const engine = yield* Gondolin.GondolinEngine.pipe(
      Effect.provide(
        layerWith((request) =>
          Effect.succeed(
            request.command === "qemu-img"
              ? output({
                  stderr: "qemu-img: not found",
                  code: ChildProcessSpawner.ExitCode(1),
                })
              : output({ stdout: "QEMU emulator version 9.0.0\n" }),
          ),
        ),
      ),
    );
    const status = yield* withGuestDirectory(engine.status());
    expect(status.available).toBe(false);
    expect(status.detail).toContain("qemu-img");
    expect(status.requirements.find((requirement) => requirement.id === "qemu-img")).toMatchObject({
      available: false,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
