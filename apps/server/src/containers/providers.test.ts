import { ContainerProviderStatus } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ContainerEngine from "./engine.ts";
import * as GondolinEngine from "./gondolin.ts";
import * as Providers from "./providers.ts";

const status = (provider: "docker" | "podman" | "gondolin"): ContainerProviderStatus => ({
  provider,
  available: true,
  version: provider,
  detail: null,
  checkedAt: 0,
});

const fixture = Effect.gen(function* () {
  const calls: Array<string> = [];
  const docker = ContainerEngine.ContainerEngine.of({
    status: (provider) =>
      Effect.sync(() => {
        calls.push(`docker:status:${provider}`);
        return status(provider);
      }),
    inspect: (provider, name) =>
      Effect.sync(() => {
        calls.push(`docker:inspect:${provider}:${name}`);
        return null;
      }),
    create: (input) =>
      Effect.sync(() => {
        calls.push(`docker:create:${input.provider}`);
        return "docker-id";
      }),
    start: (provider) =>
      Effect.sync(() => {
        calls.push(`docker:start:${provider}`);
      }),
    stop: (provider) =>
      Effect.sync(() => {
        calls.push(`docker:stop:${provider}`);
      }),
    remove: (provider) =>
      Effect.sync(() => {
        calls.push(`docker:remove:${provider}`);
      }),
    exec: (provider) =>
      Effect.sync(() => {
        calls.push(`docker:exec:${provider}`);
        return "docker";
      }),
  });
  const gondolin = GondolinEngine.GondolinEngine.of({
    status: () =>
      Effect.sync(() => {
        calls.push("gondolin:status");
        return status("gondolin");
      }),
    inspect: (name) =>
      Effect.sync(() => {
        calls.push(`gondolin:inspect:${name}`);
        return null;
      }),
    create: () =>
      Effect.sync(() => {
        calls.push("gondolin:create");
        return "gondolin-id";
      }),
    start: () =>
      Effect.sync(() => {
        calls.push("gondolin:start");
      }),
    stop: () =>
      Effect.sync(() => {
        calls.push("gondolin:stop");
      }),
    remove: () =>
      Effect.sync(() => {
        calls.push("gondolin:remove");
      }),
    exec: () =>
      Effect.sync(() => {
        calls.push("gondolin:exec");
        return "gondolin";
      }),
  });
  const service = yield* Providers.ContainerProviders.pipe(
    Effect.provide(
      Providers.layer.pipe(
        Layer.provide(Layer.succeed(ContainerEngine.ContainerEngine, docker)),
        Layer.provide(Layer.succeed(GondolinEngine.GondolinEngine, gondolin)),
      ),
    ),
  );
  return { service, calls };
});

it.effect("routes Docker and Podman through the CLI engine", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect((yield* f.service.status("docker")).provider).toBe("docker");
    expect((yield* f.service.status("podman")).provider).toBe("podman");
    expect(yield* f.service.inspect("podman", "t3-workspace-test")).toBeNull();
    expect(yield* f.service.exec("podman", "t3-workspace-test", ["/opt/t3/t3"])).toBe("docker");
    yield* f.service.start("podman", "t3-workspace-test");
    yield* f.service.stop("podman", "t3-workspace-test");
    yield* f.service.remove("podman", "t3-workspace-test");
    expect(f.calls).toEqual([
      "docker:status:docker",
      "docker:status:podman",
      "docker:inspect:podman:t3-workspace-test",
      "docker:exec:podman",
      "docker:start:podman",
      "docker:stop:podman",
      "docker:remove:podman",
    ]);
  }),
);

it.effect("routes Gondolin through the micro-VM engine", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect((yield* f.service.status("gondolin")).provider).toBe("gondolin");
    expect(yield* f.service.inspect("gondolin", "t3-workspace-test")).toBeNull();
    expect(yield* f.service.exec("gondolin", "t3-workspace-test", ["/opt/t3/t3"])).toBe("gondolin");
    yield* f.service.start("gondolin", "t3-workspace-test");
    yield* f.service.stop("gondolin", "t3-workspace-test");
    yield* f.service.remove("gondolin", "t3-workspace-test");
    expect(f.calls).toEqual([
      "gondolin:status",
      "gondolin:inspect:t3-workspace-test",
      "gondolin:exec",
      "gondolin:start",
      "gondolin:stop",
      "gondolin:remove",
    ]);
  }),
);
