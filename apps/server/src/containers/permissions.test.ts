import {
  AuthEnvironmentMaintainScope,
  CONTAINER_HOST_SCOPES,
  CONTAINER_GUEST_SCOPES,
  ContainerOperationId,
  ProjectId,
  ProviderInstanceId,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.containersCleanup
    > => tag !== WS_METHODS.containersCleanup,
  ),
);
const guestGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.containerGuestSubmit | typeof WS_METHODS.containerGuestInspect
    > => tag !== WS_METHODS.containerGuestSubmit && tag !== WS_METHODS.containerGuestInspect,
  ),
);

it.effect(
  "allows guest orchestration scopes without host maintenance and prevents read-only submission",
  () =>
    Effect.gen(function* () {
      const payload = {
        operationId: ContainerOperationId.make("permission-test"),
        message: {
          projectId: ProjectId.make("guest"),
          text: "Hello",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      } as const;
      let accepted = 0;
      const makeClient = (
        scopes: ReadonlyArray<import("@t3tools/contracts").AuthEnvironmentScope>,
      ) =>
        RpcTest.makeClient(guestGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              guestGroup.toLayerHandler(WS_METHODS.containerGuestSubmit, () =>
                Effect.sync(() => {
                  accepted++;
                  return { kind: "reserved" as const };
                }),
              ),
              guestGroup.toLayerHandler(WS_METHODS.containerGuestInspect, () =>
                Effect.succeed({ kind: "unseen" as const }),
              ),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
      const reader = yield* makeClient([AuthOrchestrationReadScope]);
      expect(yield* reader[WS_METHODS.containerGuestInspect](payload)).toEqual({ kind: "unseen" });
      expect(
        yield* reader[WS_METHODS.containerGuestSubmit](payload).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: "orchestration:operate",
      });
      expect(accepted).toBe(0);
      const guest = yield* makeClient(CONTAINER_GUEST_SCOPES);
      yield* guest[WS_METHODS.containerGuestSubmit](payload);
      expect(accepted).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect("checks full host authority before invoking container lifecycle handlers", () =>
  Effect.gen(function* () {
    let handled = 0;
    const makeClient = (scopes: ReadonlyArray<import("@t3tools/contracts").AuthEnvironmentScope>) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.containersCleanup, () =>
              Effect.sync(() => {
                handled++;
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const maintenanceOnly = yield* makeClient([AuthEnvironmentMaintainScope]);
    expect(
      yield* maintenanceOnly[WS_METHODS.containersCleanup](undefined).pipe(Effect.flip),
    ).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: "orchestration:read",
    });
    expect(handled).toBe(0);
    const client = yield* makeClient(CONTAINER_HOST_SCOPES);
    yield* client[WS_METHODS.containersCleanup](undefined);
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);
