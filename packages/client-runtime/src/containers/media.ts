import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { resolveDeviceHubAccess } from "../state/deviceHubAccess.ts";
import { containerResourceUrl } from "./endpoint.ts";

export const authorizeContainerResource = Effect.fn("containers.authorizeResource")(function* (
  relativeUrl: string,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  if (supervisor.target._tag !== "ContainerConnectionTarget")
    return { relativeUrl, expiresAt: Infinity };
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  const http = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(prepared) || Option.isNone(http))
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "The container media transport is unavailable.",
      cause: "connection-unavailable",
    });
  const resource = containerResourceUrl(prepared.value.httpBaseUrl, relativeUrl);
  if (resource === null)
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "The guest returned a resource outside its container route.",
      cause: "external-resource",
    });
  const access = yield* resolveDeviceHubAccess({ prepared: prepared.value, hubBasePath: "/" }).pipe(
    Effect.provideService(HttpClient.HttpClient, http.value),
  );
  const url = new URL(resource);
  for (const [name, value] of Object.entries(access.query)) url.searchParams.set(name, value);
  return {
    relativeUrl: url.pathname + url.search,
    expiresAt: access.query.wsTicket ? (yield* Clock.currentTimeMillis) + 4 * 60_000 : Infinity,
  };
});
