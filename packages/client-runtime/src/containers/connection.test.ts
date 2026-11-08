import {
  ContainerWorkspaceId,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ContainerConnectionTarget } from "./target.ts";
import { prepareContainerConnection } from "./connection.ts";
import { containerHttpBaseUrl } from "./endpoint.ts";
import { environmentEndpointUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { resolveAssetUrl } from "../state/assets.ts";

const hostId = EnvironmentId.make("host");
const guestId = EnvironmentId.make("guest");
const workspaceId = ContainerWorkspaceId.make("workspace");
const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: guestId,
  label: "Guest",
  serverVersion: "0.1.7",
  orchestrationProtocolVersion: 2,
  platform: { os: "linux", arch: "x64" },
  capabilities: { repositoryIdentity: true },
};
const target = new ContainerConnectionTarget({
  environmentId: guestId,
  label: "Ubuntu",
  workspaceId,
  hostEnvironmentId: hostId,
});

it.effect(
  "signs final routed descriptor/ticket/upgrade URLs with host authorization and never enrolls the guest at the relay",
  () =>
    Effect.gen(function* () {
      const proofs: Array<{ method: string; url: string; accessToken?: string }> = [];
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.includes("websocket-ticket")
                ? { ticket: "host-ticket", expiresAt: "2099-01-01T00:00:00.000Z" }
                : descriptor,
            ),
          );
        }),
      );
      const host: PreparedConnection = {
        environmentId: hostId,
        label: "Host",
        httpBaseUrl: "https://remote.example.test",
        socketUrl: "wss://remote.example.test/ws",
        target: new PrimaryConnectionTarget({
          environmentId: hostId,
          label: "Host",
          httpBaseUrl: "https://remote.example.test",
          wsBaseUrl: "wss://remote.example.test",
        }),
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "host-access",
          expiresAtEpochMs: 9999999999999,
        },
      };
      const prepared = yield* prepareContainerConnection(target, host).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.mock(ManagedRelay.ManagedRelayDpopSigner)({
              createProof: (input) =>
                Effect.sync(() => {
                  proofs.push(input);
                  return "signed-proof";
                }),
            }),
          ),
        ),
      );
      const base = "https://remote.example.test/api/container-gateway/workspace";
      expect(requests).toEqual([
        `${base}/.well-known/t3/environment`,
        `${base}/api/auth/websocket-ticket/rpc`,
      ]);
      expect(proofs.map((proof) => proof.url)).toEqual([
        `${base}/.well-known/t3/environment`,
        `${base}/api/auth/websocket-ticket/rpc`,
        `${base}/ws`,
      ]);
      expect(proofs.at(-1)?.accessToken).toBe("host-ticket");
      expect(prepared.environmentId).toBe(guestId);
      expect(prepared.httpAuthorization).toEqual(host.httpAuthorization);
      expect(prepared.socketUrl).toContain(
        "/api/container-gateway/workspace/ws?wsTicket=host-ticket&dpop=signed-proof",
      );
    }),
);

it("keeps HTTP, assets and uploads on the child prefix without changing ordinary origin normalization", () => {
  const base = containerHttpBaseUrl("https://remote.example.test", workspaceId);
  expect(environmentEndpointUrl(base, "/api/projects")).toBe(
    "https://remote.example.test/api/container-gateway/workspace/api/projects",
  );
  expect(makeEnvironmentHttpApiUrlBuilder(base).projects.snapshot()).toBe(
    "https://remote.example.test/api/container-gateway/workspace/api/projects",
  );
  expect(resolveAssetUrl(base, "/api/assets/signed?resource=one")).toBe(
    "https://remote.example.test/api/container-gateway/workspace/api/assets/signed?resource=one",
  );
  expect(resolveAssetUrl(base, "/api/attachments/upload/signed?wsTicket=host-media")).toBe(
    "https://remote.example.test/api/container-gateway/workspace/api/attachments/upload/signed?wsTicket=host-media",
  );
  expect(resolveAssetUrl(base, "https://other.test/steal")).toBeNull();
  expect(environmentEndpointUrl("https://normal.test/ignored?also=ignored", "/api/projects")).toBe(
    "https://normal.test/api/projects",
  );
  expect(normalizeHttpBaseUrl(base)).toBe("https://remote.example.test/");
});
