import {
  AuthEnvironmentMaintainScope,
  CONTAINER_HOST_SCOPES,
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
