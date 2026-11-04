import { WS_METHODS, type ContainerDestination } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { ConnectionBlockedError } from "../connection/model.ts";
import { ContainerConnectionRegistration, ContainerConnectionTarget } from "./target.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createRuntimeCommand } from "../state/runtime.ts";

export function createContainerCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    connect: createRuntimeCommand(runtime, {
      label: "containers:connect",
      execute: Effect.fn("containers.connect")(function* (destination: ContainerDestination) {
        const registry = yield* EnvironmentRegistry;
        yield* registry.register(
          new ContainerConnectionRegistration({
            target: new ContainerConnectionTarget({
              environmentId: destination.guestEnvironmentId,
              hostEnvironmentId: destination.hostEnvironmentId,
              workspaceId: destination.workspaceId,
              label: destination.label,
            }),
          }),
        );
        const state = yield* registry.stateChanges(destination.guestEnvironmentId).pipe(
          Stream.filter((state) => state.phase === "connected" || state.phase === "blocked"),
          Stream.runHead,
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new ConnectionBlockedError({
                  reason: "configuration",
                  detail:
                    "The container connection is not ready. Your source draft is unchanged; retry after reconnecting the host.",
                }),
              ),
          }),
        );
        if (Option.isNone(state) || state.value.phase !== "connected")
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: Option.isSome(state)
              ? (state.value.lastFailure?.message ?? "The container connection was refused.")
              : "The container connection closed.",
          });
        return yield* registry.run(
          destination.guestEnvironmentId,
          request(WS_METHODS.serverGetConfig, {}),
        );
      }),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "containers:open",
      tag: WS_METHODS.containersOpen,
    }),
    settings: createEnvironmentRpcCommand(runtime, {
      label: "containers:settings",
      tag: WS_METHODS.containersSettings,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "containers:configure",
      tag: WS_METHODS.containersConfigure,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "containers:act",
      tag: WS_METHODS.containersAct,
    }),
    cleanup: createEnvironmentRpcCommand(runtime, {
      label: "containers:cleanup",
      tag: WS_METHODS.containersCleanup,
    }),
  };
}
