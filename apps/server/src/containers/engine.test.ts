import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ContainerEngine from "./engine.ts";

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
  ContainerEngine.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })));

it.effect("reports Docker available from a working info probe", () =>
  Effect.gen(function* () {
    const engine = yield* ContainerEngine.ContainerEngine.pipe(
      Effect.provide(
        layerWith((input) =>
          Effect.succeed(
            input.args[0] === "--version"
              ? output({ stdout: "Docker version 29.1.3, build test" })
              : output({ stdout: "Server Version: 29.1.3" }),
          ),
        ),
      ),
    );
    const status = yield* engine.status("docker");
    expect(status).toEqual({
      runtime: "docker",
      available: true,
      version: "Docker version 29.1.3, build test",
      detail: null,
      checkedAt: 0,
    });
  }),
);

it.effect("reports Podman unavailable with the final error line and caches the probe", () =>
  Effect.gen(function* () {
    let probes = 0;
    const engine = yield* ContainerEngine.ContainerEngine.pipe(
      Effect.provide(
        layerWith((input) => {
          probes++;
          return Effect.succeed(
            input.args[0] === "--version"
              ? output({ stdout: "podman version 5.7.0" })
              : output({
                  stderr:
                    "warning: storage driver changed\nError: cannot set up namespace using newuidmap\n",
                  code: ChildProcessSpawner.ExitCode(125),
                }),
          );
        }),
      ),
    );
    const first = yield* engine.status("podman");
    const second = yield* engine.status("podman");
    expect(first.available).toBe(false);
    expect(first.version).toBe("podman version 5.7.0");
    expect(first.detail).toBe("Error: cannot set up namespace using newuidmap");
    expect(second).toBe(first);
    expect(probes).toBe(2);
  }),
);

it.effect("treats a missing Podman container as absent after info succeeds", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const engine = yield* ContainerEngine.ContainerEngine.pipe(
      Effect.provide(
        layerWith((input) => {
          calls.push(input.args.join(" "));
          return Effect.succeed(
            input.args[0] === "container"
              ? output({ stderr: "no such container", code: ChildProcessSpawner.ExitCode(1) })
              : output({ stdout: "host" }),
          );
        }),
      ),
    );
    const inspected = yield* engine.inspect("podman", "t3-workspace-test");
    expect(inspected).toBeNull();
    expect(calls).toEqual(["container inspect t3-workspace-test", "info"]);
  }),
);
