import {
  AuthSessionId,
  CONTAINER_GUEST_SCOPES,
  ContainerError,
  EnvironmentId,
  ProjectId,
  type ContainerWorkspaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as SessionStore from "../auth/SessionStore.ts";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ContainerProviders from "./providers.ts";
import { GUEST_HOME, GUEST_PORT, GUEST_RUNTIME } from "./bootstrap.ts";
import type { WorkspaceRecord } from "./registry.ts";

const GuestIdentity = Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId });
const IssuedGuestSession = Schema.Struct({ sessionId: AuthSessionId, token: Schema.String });
const decodeSession = Schema.decodeEffect(Schema.fromJsonString(IssuedGuestSession));
const decodeIdentity = Schema.decodeUnknownEffect(GuestIdentity);
const decodeIdle = Schema.decodeUnknownEffect(Schema.Struct({ idle: Schema.Boolean }));
const isContainerError = Schema.is(ContainerError);
type CredentialInput = {
  readonly seconds: number;
  readonly subject: string;
  readonly parent?: { readonly sessionId: AuthSessionId; readonly proofKeyThumbprint?: string };
};
export class GuestConnection extends Context.Service<
  GuestConnection,
  {
    readonly origin: (record: WorkspaceRecord) => Effect.Effect<string, ContainerError>;
    readonly credential: (
      record: WorkspaceRecord,
      input: CredentialInput,
    ) => Effect.Effect<string, ContainerError>;
    readonly prepare: (
      record: WorkspaceRecord,
    ) => Effect.Effect<typeof GuestIdentity.Type, ContainerError>;
    readonly idle: (record: WorkspaceRecord) => Effect.Effect<boolean, ContainerError>;
  }
>()("t3/containers/GuestConnection") {}

export const containerName = (id: ContainerWorkspaceId) => `t3-workspace-${id}`;

const make = Effect.gen(function* () {
  const providers = yield* ContainerProviders.ContainerProviders;
  const http = yield* HttpClient.HttpClient;
  const sessions = yield* SessionStore.SessionStore;
  const locks = yield* KeyedLock.make<string>();
  const credentials = new Map<
    string,
    { readonly token: string; readonly expiresAt: number; readonly sessionId: AuthSessionId }
  >();
  const watched = new Set<string>();
  const serviceScope = yield* Scope.Scope;
  const origin = Effect.fn("GuestConnection.origin")(function* (record: WorkspaceRecord) {
    const providerStatus = yield* providers.status(record.provider);
    if (!providerStatus.available)
      return yield* new ContainerError({ stage: "provider", reason: "provider-unavailable" });
    const inspected = yield* providers.inspect(record.provider, containerName(record.id));
    const labels = inspected?.Config.Labels;
    if (
      !inspected ||
      labels?.["codes.t3.workspace"] !== record.id ||
      labels["codes.t3.owner"] !== record.ownerEnvironmentId ||
      (record.containerId !== null && record.containerId !== inspected.Id) ||
      !record.mounts.every((mount) =>
        inspected.Mounts.some(
          (actual) => actual.Source === mount.source && actual.Destination === mount.target,
        ),
      )
    ) {
      return yield* new ContainerError({ stage: "identity", reason: "incompatible" });
    }
    const port = inspected.NetworkSettings.Ports[`${GUEST_PORT}/tcp`]?.find(
      (binding) => binding.HostIp === "127.0.0.1",
    );
    if (!inspected.State.Running || !port || !/^\d+$/.test(port.HostPort)) {
      return yield* new ContainerError({ stage: "listener", reason: "guest-failed" });
    }
    return `http://127.0.0.1:${port.HostPort}`;
  });
  const credential = Effect.fn("GuestConnection.credential")(function* (
    record: WorkspaceRecord,
    input: CredentialInput,
  ) {
    const key = `${record.id}/${input.subject}`;
    return yield* locks.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = credentials.get(key);
        if (
          cached &&
          cached.expiresAt > now + 10_000 &&
          cached.expiresAt <= now + input.seconds * 1000 + 1000
        )
          return cached.token;
        for (const [id, entry] of credentials) if (entry.expiresAt <= now) credentials.delete(id);
        const json = yield* providers.exec(
          record.provider,
          containerName(record.id),
          [
            `${GUEST_RUNTIME}/t3`,
            "auth",
            "session",
            "issue",
            "--base-dir",
            `${GUEST_HOME}/.t3`,
            "--ttl",
            `${input.seconds} seconds`,
            "--subject",
            input.subject,
            ...CONTAINER_GUEST_SCOPES.flatMap((scope) => ["--scope", scope]),
            "--json",
          ],
          { user: "t3", env: { HOME: GUEST_HOME } },
        );
        const issued = yield* decodeSession(json).pipe(
          Effect.mapError(
            () => new ContainerError({ stage: "guest-session", reason: "guest-failed" }),
          ),
        );
        const entry = {
          token: issued.token,
          expiresAt: now + input.seconds * 1000,
          sessionId: issued.sessionId,
        };
        credentials.set(key, entry);
        if (input.parent && !watched.has(key)) {
          watched.add(key);
          yield* sessions
            .awaitInvalidation(input.parent.sessionId, input.parent.proofKeyThumbprint)
            .pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.gen(function* () {
                  const current = credentials.get(key);
                  credentials.delete(key);
                  watched.delete(key);
                  if (!current) return;
                  yield* providers.exec(
                    record.provider,
                    containerName(record.id),
                    [
                      `${GUEST_RUNTIME}/t3`,
                      "auth",
                      "session",
                      "revoke",
                      "--base-dir",
                      `${GUEST_HOME}/.t3`,
                      current.sessionId,
                    ],
                    { user: "t3", env: { HOME: GUEST_HOME } },
                  );
                }),
              ),
              Effect.ignore,
              Effect.forkIn(serviceScope),
            );
        }
        return issued.token;
      }),
    );
  });
  const prepare = Effect.fn("GuestConnection.prepare")(function* (record: WorkspaceRecord) {
    const base = yield* origin(record);
    const identity = yield* Effect.scoped(
      Effect.gen(function* () {
        const token = yield* credential(record, { seconds: 300, subject: "container-bootstrap" });
        const response = yield* http.execute(
          HttpClientRequest.post(`${base}/api/containers/guest/prepare`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({ checkoutPath: record.checkoutPath }),
          ),
        );
        if (response.status !== 200)
          return yield* new ContainerError({ stage: "readiness", reason: "guest-failed" });
        return yield* decodeIdentity(yield* response.json);
      }),
    ).pipe(
      Effect.retry(Schedule.spaced("1 second")),
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () =>
          Effect.fail(new ContainerError({ stage: "readiness", reason: "guest-failed" })),
      }),
      Effect.mapError((cause) =>
        isContainerError(cause)
          ? cause
          : new ContainerError({ stage: "readiness", reason: "guest-failed", cause }),
      ),
    );
    if (record.guest !== null && record.guest.environmentId !== identity.environmentId)
      return yield* new ContainerError({ stage: "guest-identity", reason: "incompatible" });
    return identity;
  });
  const idle = Effect.fn("GuestConnection.idle")(function* (record: WorkspaceRecord) {
    const base = yield* origin(record);
    const token = yield* credential(record, { seconds: 30, subject: "container-idle-check" });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* http.execute(
          HttpClientRequest.get(`${base}/api/containers/guest/idle`).pipe(
            HttpClientRequest.bearerToken(token),
          ),
        );
        if (response.status !== 200) return false;
        return (yield* decodeIdle(yield* response.json)).idle;
      }),
    ).pipe(
      Effect.mapError((cause) => new ContainerError({ stage: "idle", reason: "busy", cause })),
    );
  });
  return GuestConnection.of({ origin, credential, prepare, idle });
});
export const layer = Layer.effect(GuestConnection, make);
