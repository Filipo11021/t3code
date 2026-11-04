import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthStandardClientScopes,
  ContainerOperationId,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ContainerWorkspaces from "./ContainerWorkspaces.ts";
import * as GuestConnection from "./GuestConnection.ts";
import * as Gateway from "./gateway.ts";
import type { WorkspaceRecord } from "./registry.ts";

const id = ContainerWorkspaceId.make("workspace-one");
const record: WorkspaceRecord = {
  id,
  operationId: ContainerOperationId.make(id),
  ownership: "managed",
  ownerEnvironmentId: EnvironmentId.make("host"),
  projectId: ProjectId.make("project"),
  checkoutPath: "/repo",
  image: "ubuntu:26.04",
  config: DEFAULT_CONTAINER_CONFIG,
  status: { type: "stopped" },
  lastUsedAt: 0,
  runtimeRevision: "revision",
  runtimePath: "/runtime",
  directory: "/state",
  mounts: [{ source: "/repo", target: "/repo" }],
  containerId: "container",
  guest: null,
};

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest("/tmp/opencode", { prefix: "container-gateway-auth-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(NodePlatformCrypto.layer),
);

it.live(
  "authenticates every routed HTTP/media/upgrade, strips host credentials and refuses lower-scope callers",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const session = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
      const reader = yield* auth.issueSession({
        scopes: ["orchestration:read", "environment:maintain"],
      });
      const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({ url: request.url, headers: request.headers });
          return HttpClientResponse.fromWeb(
            request,
            new Response("guest-body", {
              headers: { "set-cookie": "guest=secret", "content-type": "text/plain" },
            }),
          );
        }),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        Gateway.layer.pipe(
          Layer.provide(
            Layer.mock(ContainerWorkspaces.ContainerWorkspaces)({
              route: () => Effect.succeed({ record, closed: Effect.never }),
            }),
          ),
          Layer.provide(
            Layer.mock(GuestConnection.GuestConnection)({
              origin: () => Effect.succeed("http://127.0.0.1:41111"),
              credential: () => Effect.succeed("guest-only-token"),
            }),
          ),
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth),
              Layer.succeed(SessionStore.SessionStore, sessions),
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const call = (suffix: string, init?: RequestInit) =>
        Effect.promise(() =>
          handler(
            new Request(`https://remote-host.test/api/container-gateway/${id}${suffix}`, init),
          ),
        );
      const anonymous = yield* call("/.well-known/t3/environment");
      expect(anonymous.status).toBe(401);
      for (const suffix of ["/.well-known/t3/environment", "/api/assets/file", "/ws"]) {
        const response = yield* call(suffix, {
          headers: {
            authorization: `Bearer ${reader.token}`,
            ...(suffix === "/ws" ? { upgrade: "websocket" } : {}),
          },
        });
        expect(response.status).toBe(403);
      }
      expect(requests).toHaveLength(0);
      const response = yield* call("/api/projects?query=kept", {
        headers: {
          authorization: `Bearer ${session.token}`,
          cookie: "host=private",
          dpop: "host-proof",
          "x-forwarded-host": "remote-host.test",
        },
      });
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("guest-body");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(requests[0]?.url).toBe("http://127.0.0.1:41111/api/projects?query=kept");
      expect(requests[0]?.headers.authorization).toBe("Bearer guest-only-token");
      expect(requests[0]?.headers).not.toHaveProperty("cookie");
      expect(requests[0]?.headers).not.toHaveProperty("dpop");
      expect(requests[0]?.headers).not.toHaveProperty("x-forwarded-host");
      const media = yield* auth.issueWebSocketTicket(session, { use: "media" });
      const mediaResponse = yield* call(
        `/api/assets/file?wsTicket=${encodeURIComponent(Redacted.value(media.ticket))}`,
      );
      expect(mediaResponse.status).toBe(200);
      yield* Effect.promise(() => mediaResponse.text());
      expect(requests.at(-1)?.url).toBe("http://127.0.0.1:41111/api/assets/file");
      const wrongAudience = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
      expect(
        (yield* call(
          `/api/assets/file?wsTicket=${encodeURIComponent(Redacted.value(wrongAudience.ticket))}`,
        )).status,
      ).toBe(401);
      const ticketResponse = yield* call("/api/auth/websocket-ticket/media", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(ticketResponse.status).toBe(200);
      const issued = yield* Effect.promise(() => ticketResponse.json());
      expect(issued).toHaveProperty("ticket");
      expect(requests).toHaveLength(2);
      yield* auth.revokeSession(session.sessionId);
      expect(
        (yield* call("/api/projects", { headers: { authorization: `Bearer ${session.token}` } }))
          .status,
      ).toBe(401);
    }).pipe(Effect.provide(authLayer)),
);

it.live(
  "substitutes a guest RPC socket ticket, streams frames, and closes the socket when host authorization is revoked",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const session = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
      const ticket = yield* auth.issueWebSocketTicket(session, { use: "rpc" });
      const guest = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of server.clients) socket.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      if (!guest.address())
        yield* Effect.promise(
          () => new Promise<void>((resolve) => guest.once("listening", resolve)),
        );
      const address = guest.address();
      if (!address || typeof address === "string") throw new Error("Missing guest port");
      const guestRequests: string[] = [];
      guest.on("connection", (socket, request) => {
        guestRequests.push(request.url ?? "");
        socket.on("message", (data, binary) => socket.send(data, { binary }));
      });
      const credentials: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          credentials.push(request.headers.authorization ?? "");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ ticket: "guest-socket-ticket", expiresAt: "2099-01-01T00:00:00.000Z" }),
          );
        }),
      );
      const context = yield* Layer.build(
        HttpRouter.serve(
          Gateway.layer.pipe(HttpRouter.provideRequest(Layer.succeed(HttpClient.HttpClient, http))),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(
            Layer.mock(ContainerWorkspaces.ContainerWorkspaces)({
              route: () => Effect.succeed({ record, closed: Effect.never }),
            }),
          ),
          Layer.provide(
            Layer.mock(GuestConnection.GuestConnection)({
              origin: () => Effect.succeed(`http://127.0.0.1:${address.port}`),
              credential: () => Effect.succeed("guest-only-token"),
            }),
          ),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth),
              Layer.succeed(SessionStore.SessionStore, sessions),
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
        ),
      );
      const origin = HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address,
      ).replace(/^http/, "ws");
      const socket = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(
              `${origin}/api/container-gateway/${id}/ws?wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}&orchestrationProtocol=2`,
            ),
        ),
        (client) => Effect.sync(() => client.close()),
      );
      const echo = Promise.withResolvers<string>();
      const closed = Promise.withResolvers<void>();
      socket.addEventListener("open", () => socket.send("guest-rpc-frame"));
      socket.addEventListener("message", (event) => echo.resolve(String(event.data)));
      socket.addEventListener("error", () => echo.reject(new Error("Gateway WebSocket failed")));
      socket.addEventListener("close", () => closed.resolve());
      expect(yield* Effect.promise(() => echo.promise)).toBe("guest-rpc-frame");
      expect(guestRequests).toEqual(["/ws?orchestrationProtocol=2&wsTicket=guest-socket-ticket"]);
      expect(credentials).toEqual(["Bearer guest-only-token"]);
      yield* auth.revokeSession(session.sessionId);
      yield* Effect.promise(() => closed.promise);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }).pipe(Effect.provide(authLayer)),
);

it("does not expose arbitrary guest HTML, authentication controls, recursive containers or ambiguous paths", () => {
  for (const path of [
    "/index.html",
    "/oauth/token",
    "/api/auth/browser-session",
    "/api/containers/open",
    "/api/../projects",
    "/api/%2e%2e/projects",
    "//other-host",
  ]) {
    expect(Gateway.parseContainerRoute(`/api/container-gateway/${id}${path}`)).toBeNull();
  }
  expect(
    Gateway.parseContainerRoute(`/api/container-gateway/${id}/api/projects`)?.workspaceId,
  ).toBe(id);
});
