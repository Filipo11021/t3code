import {
  ContainerError,
  type ContainerProviderKind,
  type ContainerProviderStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ContainerEngine from "./engine.ts";
import * as GondolinEngine from "./gondolin.ts";
import type { ContainerCreateInput, ContainerExecOptions } from "./providerTypes.ts";

export class ContainerProviders extends Context.Service<
  ContainerProviders,
  {
    readonly status: (
      provider: ContainerProviderKind,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<ContainerProviderStatus>;
    readonly inspect: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<ContainerEngine.Inspection | null, ContainerError>;
    readonly create: (input: ContainerCreateInput) => Effect.Effect<string, ContainerError>;
    readonly start: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly stop: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly remove: (
      provider: ContainerProviderKind,
      name: string,
    ) => Effect.Effect<void, ContainerError>;
    readonly exec: (
      provider: ContainerProviderKind,
      name: string,
      command: ReadonlyArray<string>,
      options?: ContainerExecOptions,
    ) => Effect.Effect<string, ContainerError>;
  }
>()("t3/containers/providers/ContainerProviders") {}

const make = Effect.gen(function* () {
  const docker = yield* ContainerEngine.ContainerEngine;
  const gondolin = yield* GondolinEngine.GondolinEngine;
  const isGondolin = (provider: ContainerProviderKind) => provider === "gondolin";
  const status = Effect.fn("ContainerProviders.status")(function* (
    provider: ContainerProviderKind,
    options?: { readonly refresh?: boolean },
  ) {
    return yield* isGondolin(provider)
      ? gondolin.status(options)
      : docker.status(provider, options);
  });
  const inspect = Effect.fn("ContainerProviders.inspect")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    return yield* isGondolin(provider) ? gondolin.inspect(name) : docker.inspect(provider, name);
  });
  const create = Effect.fn("ContainerProviders.create")(function* (input: ContainerCreateInput) {
    return yield* isGondolin(input.provider) ? gondolin.create(input) : docker.create(input);
  });
  const start = Effect.fn("ContainerProviders.start")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    if (isGondolin(provider)) return yield* gondolin.start(name);
    return yield* docker.start(provider, name);
  });
  const stop = Effect.fn("ContainerProviders.stop")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    if (isGondolin(provider)) return yield* gondolin.stop(name);
    return yield* docker.stop(provider, name);
  });
  const remove = Effect.fn("ContainerProviders.remove")(function* (
    provider: ContainerProviderKind,
    name: string,
  ) {
    if (isGondolin(provider)) return yield* gondolin.remove(name);
    return yield* docker.remove(provider, name);
  });
  const exec = Effect.fn("ContainerProviders.exec")(function* (
    provider: ContainerProviderKind,
    name: string,
    command: ReadonlyArray<string>,
    options?: ContainerExecOptions,
  ) {
    return yield* isGondolin(provider)
      ? gondolin.exec(name, command, options)
      : docker.exec(provider, name, command, options);
  });
  return ContainerProviders.of({ status, inspect, create, start, stop, remove, exec });
});

export const layer = Layer.effect(ContainerProviders, make);
