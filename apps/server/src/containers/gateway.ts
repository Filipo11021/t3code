import {
  AuthWebSocketTicketResult,
  CONTAINER_GATEWAY_PREFIX,
  CONTAINER_HOST_SCOPES,
  ContainerWorkspaceId,
  type AuthWebSocketTicketUse,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ContainerWorkspaces from "./ContainerWorkspaces.ts";
import * as GuestConnection from "./GuestConnection.ts";
import * as ContainerGuest from "./GuestService.ts";
const encodeTicket = Schema.encodeEffect(Schema.toCodecJson(AuthWebSocketTicketResult));
const decodeTicket = Schema.decodeEffect(Schema.toCodecJson(AuthWebSocketTicketResult));
const decodePrepare = Schema.decodeUnknownEffect(Schema.Struct({ checkoutPath: Schema.String }));

const dropped = new Set([
  "host",
  "connection",
  "upgrade",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "origin",
  "forwarded",
  "proxy-authorization",
]);
function guestRequestHeaders(headers: Readonly<Record<string, string | undefined>>, token: string) {
  const result: Record<string, string> = { authorization: `Bearer ${token}` };
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      value === undefined ||
      dropped.has(key) ||
      key.startsWith("sec-websocket-") ||
      key.startsWith("x-forwarded-") ||
      (key.startsWith("x-t3-") && key !== ORCHESTRATION_PROTOCOL_HEADER) ||
      key.startsWith("proxy-")
    )
      continue;
    result[key] = value;
  }
  return result;
}

export function parseContainerRoute(pathname: string) {
  const match = /^\/api\/container-gateway\/([a-zA-Z0-9-]{1,80})(\/.*)$/.exec(pathname);
  if (!match || !match[1] || !match[2] || /%2e|%2f|%5c|\\|\/\.{1,2}(?:\/|$)|\/\//i.test(match[2]))
    return null;
  const path = match[2];
  if (
    path.startsWith("/api/containers/") ||
    path.startsWith("/api/cloud/") ||
    (path.startsWith("/api/auth/") &&
      path !== "/api/auth/session" &&
      !/^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/.test(path))
  )
    return null;
  if (path !== "/ws" && path !== "/.well-known/t3/environment" && !path.startsWith("/api/"))
    return null;
  return { workspaceId: ContainerWorkspaceId.make(match[1]), path };
}

const requireContainerAuthority = (session: EnvironmentAuth.AuthenticatedSession) =>
  CONTAINER_HOST_SCOPES.every((scope) => session.scopes.includes(scope));

const pump =
  // Socket framing already owns a request span; chunks do not need individual spans.
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) yield* sink.writeAll(yield* pull);
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parsedUrl = requestUrl(request);
  if (Option.isNone(parsedUrl)) return HttpServerResponse.empty({ status: 400 });
  const route = parseContainerRoute(parsedUrl.value.pathname);
  if (route === null) return HttpServerResponse.empty({ status: 404 });
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
  const media = !upgrade && parsedUrl.value.searchParams.has("wsTicket");
  const use: AuthWebSocketTicketUse = route.path === "/ws" ? "rpc" : "media";
  const session = yield* upgrade || media
    ? auth.authenticateWebSocketUpgrade(request, use)
    : auth.authenticateHttpRequest(request);
  if (!requireContainerAuthority(session))
    return HttpServerResponse.text("Container access requires full host maintenance authority.", {
      status: 403,
    });
  const ticket = /^\/api\/auth\/websocket-ticket(?:\/(rpc|media))?$/.exec(route.path);
  if (ticket && request.method === "POST") {
    const use = ticket[1] === "media" ? "media" : "rpc";
    const issued = yield* auth.issueWebSocketTicket(session, { use });
    return yield* HttpServerResponse.json(yield* encodeTicket(issued));
  }
  const workspaces = yield* ContainerWorkspaces.ContainerWorkspaces;
  const guests = yield* GuestConnection.GuestConnection;
  const { record, closed } = yield* workspaces.route(route.workspaceId);
  const now = yield* Clock.currentTimeMillis;
  const seconds = Math.floor(
    Math.min(
      300_000,
      session.expiresAt ? DateTime.toEpochMillis(session.expiresAt) - now : 300_000,
    ) / 1000,
  );
  if (seconds < 1) return HttpServerResponse.empty({ status: 401 });
  const origin = yield* guests.origin(record);
  const token = yield* guests.credential(record, {
    seconds,
    subject: `container-gateway-${session.sessionId}`,
    parent: session,
  });
  const invalidated = Effect.raceFirst(
    closed,
    sessions.awaitInvalidation(session.sessionId, session.proofKeyThumbprint),
  );
  const search = new URLSearchParams(parsedUrl.value.search);
  search.delete("wsTicket");
  search.delete("dpop");
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  if (upgrade) {
    const issuedResponse = yield* http.execute(
      HttpClientRequest.post(`${origin}/api/auth/websocket-ticket/${use}`).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    );
    if (issuedResponse.status !== 200) return HttpServerResponse.empty({ status: 502 });
    const issued = yield* decodeTicket(yield* issuedResponse.json);
    search.set("wsTicket", Redacted.value(issued.ticket));
    const upstream = yield* Socket.makeWebSocket(
      `${origin.replace(/^http/, "ws")}${route.path}?${search}`,
      { openTimeout: "10 seconds" },
    ).pipe(Effect.provide(upstreamWebSocketConstructor));
    const client = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const toClient = yield* client.writer;
        const toGuest = yield* upstream.writer;
        yield* Effect.raceFirst(
          invalidated,
          Effect.raceFirst(pump(client, toGuest), pump(upstream, toClient)),
        );
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }
  if (!HttpMethod.isHttpMethod(request.method)) return HttpServerResponse.empty({ status: 405 });
  const upstreamUrl = `${origin}${route.path}${search.size ? `?${search}` : ""}`;
  const response = yield* http.execute(
    HttpClientRequest.make(request.method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders(guestRequestHeaders(request.headers, token)),
      request.method === "GET" || request.method === "HEAD"
        ? (self) => self
        : HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          }),
    ),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      value !== undefined &&
      ![
        "set-cookie",
        "connection",
        "transfer-encoding",
        "content-encoding",
        "location",
        "access-control-allow-origin",
        "access-control-allow-credentials",
      ].includes(name)
    )
      headers[name] = value;
  }
  headers["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(invalidated)), {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
}).pipe(
  Effect.catch((error) =>
    Effect.succeed(
      HttpServerResponse.text(
        EnvironmentAuth.isServerAuthCredentialError(error)
          ? "Authentication required."
          : "Container guest unavailable.",
        { status: EnvironmentAuth.isServerAuthCredentialError(error) ? 401 : 503 },
      ),
    ),
  ),
);

const guestHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request);
  if (!session.scopes.includes("orchestration:operate"))
    return HttpServerResponse.empty({ status: 403 });
  const guest = yield* ContainerGuest.ContainerGuest;
  if (
    request.originalUrl.split("?")[0] === "/api/containers/guest/idle" &&
    request.method === "GET"
  )
    return yield* HttpServerResponse.json({ idle: yield* guest.idle });
  const input = yield* decodePrepare(yield* request.json);
  return yield* HttpServerResponse.json(yield* guest.prepare(input.checkoutPath));
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const workspaces = yield* ContainerWorkspaces.ContainerWorkspaces;
    const guests = yield* GuestConnection.GuestConnection;
    return HttpRouter.add(
      "*",
      `${CONTAINER_GATEWAY_PREFIX}/*`,
      handler.pipe(
        Effect.provideService(ContainerWorkspaces.ContainerWorkspaces, workspaces),
        Effect.provideService(GuestConnection.GuestConnection, guests),
      ),
    );
  }),
);
export const guestLayer = Layer.unwrap(
  Effect.gen(function* () {
    const guestMode = yield* Config.String("T3CODE_CONTAINER_GUEST").pipe(Config.withDefault("0"));
    if (guestMode !== "1") return Layer.empty;
    const guest = yield* ContainerGuest.ContainerGuest;
    return HttpRouter.add(
      "*",
      "/api/containers/guest/*",
      guestHandler.pipe(Effect.provideService(ContainerGuest.ContainerGuest, guest)),
    );
  }),
);
