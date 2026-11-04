import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { ConnectionBlockedError, type PreparedConnection } from "../connection/model.ts";
import type { ContainerConnectionTarget } from "./target.ts";
import { containerHttpBaseUrl } from "./endpoint.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
const decodeDescriptor = Schema.decodeEffect(Schema.toCodecJson(ExecutionEnvironmentDescriptor));
const isConnectionBlockedError = Schema.is(ConnectionBlockedError);

export const prepareContainerConnection = Effect.fn("containers.prepareConnection")(function* (
  target: ContainerConnectionTarget,
  host: PreparedConnection,
) {
  const httpBaseUrl = containerHttpBaseUrl(host.httpBaseUrl, target.workspaceId);
  const wsBaseUrl = environmentEndpointUrl(httpBaseUrl, "/ws").replace(/^http/, "ws");
  const authorization = host.httpAuthorization;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  if (authorization?._tag === "Dpop" && Option.isNone(signer))
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The host's proof signer is unavailable.",
    });
  const url = environmentEndpointUrl(httpBaseUrl, "/.well-known/t3/environment");
  const headers =
    authorization?._tag === "Bearer"
      ? { authorization: `Bearer ${authorization.token}` }
      : authorization?._tag === "Dpop" && Option.isSome(signer)
        ? {
            authorization: `DPoP ${authorization.accessToken}`,
            dpop: yield* signer.value
              .createProof({ method: "GET", url, accessToken: authorization.accessToken })
              .pipe(
                Effect.mapError(
                  () =>
                    new ConnectionBlockedError({
                      reason: "authentication",
                      detail: "Could not sign the container route.",
                    }),
                ),
              ),
          }
        : {};
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const descriptor = yield* Effect.scoped(
    Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
      );
      if (response.status !== 200)
        return yield* new ConnectionBlockedError({
          reason: response.status === 403 ? "permission" : "configuration",
          detail:
            "The container is stopped or this host connection lacks full maintenance authority. Open it from the host workspace menu.",
        });
      return yield* decodeDescriptor(yield* response.json);
    }),
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
    Effect.mapError((cause) =>
      isConnectionBlockedError(cause)
        ? cause
        : new ConnectionBlockedError({
            reason: "configuration",
            detail: "Could not read the container environment through its host.",
          }),
    ),
  );
  if (descriptor.environmentId !== target.environmentId)
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The container's environment identity changed. Reopen it from its host.",
    });
  let socketUrl = wsBaseUrl;
  if (authorization?._tag === "Bearer")
    socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
      httpBaseUrl,
      wsBaseUrl,
      bearerToken: authorization.token,
    }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
  if (authorization?._tag === "Dpop" && Option.isSome(signer))
    socketUrl = yield* resolveRemoteDpopWebSocketConnectionUrl({
      httpBaseUrl,
      wsBaseUrl,
      accessToken: authorization.accessToken,
      createProof: (input) =>
        signer.value.createProof(input).pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentAuthFetchError({
                message: "Could not sign the container socket route.",
                cause,
              }),
          ),
        ),
    }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
  return {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl,
    socketUrl,
    httpAuthorization: authorization,
    target,
    descriptor,
  } satisfies PreparedConnection & { readonly descriptor: ExecutionEnvironmentDescriptor };
});
