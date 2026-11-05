import {
  ContainerOperationId,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SessionStore from "../auth/SessionStore.ts";
import * as GuestConnection from "./GuestConnection.ts";
import * as Engine from "./engine.ts";
import type { WorkspaceRecord } from "./registry.ts";

it.effect("waits for long setup hooks after session issuance and bounds total readiness", () =>
  Effect.gen(function* () {
    const hostId = EnvironmentId.make("host");
    const guestId = EnvironmentId.make("guest");
    const workspaceId = ContainerWorkspaceId.make("workspace");
    const identity = { environmentId: guestId, projectId: ProjectId.make("guest-project") };
    const record: WorkspaceRecord = {
      id: workspaceId,
      operationId: ContainerOperationId.make("operation"),
      ownership: "managed",
      ownerEnvironmentId: hostId,
      projectId: ProjectId.make("project"),
      checkoutPath: "/repo",
      image: "ubuntu:26.04",
      config: DEFAULT_CONTAINER_CONFIG,
      status: { type: "provisioning", stage: "start" },
      lastUsedAt: 0,
      runtimeRevision: "revision",
      runtimePath: "/runtime",
      directory: "/state",
      mounts: [],
      containerId: "container",
      guest: null,
    };
    let ready = false;
    const service = yield* GuestConnection.GuestConnection.pipe(
      Effect.provide(
        GuestConnection.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "test-session",
                legacyCookieName: undefined,
              }),
              Layer.mock(Engine.ContainerEngine)({
                inspect: () =>
                  Effect.succeed({
                    Id: "container",
                    Config: {
                      Labels: { "codes.t3.workspace": workspaceId, "codes.t3.owner": hostId },
                    },
                    State: { Running: true },
                    Mounts: [],
                    NetworkSettings: {
                      Ports: { "3773/tcp": [{ HostIp: "127.0.0.1", HostPort: "12345" }] },
                    },
                  }),
                run: () =>
                  Effect.succeed(JSON.stringify({ sessionId: "session", token: "test-only" })),
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() =>
                    HttpClientResponse.fromWeb(
                      request,
                      ready ? Response.json(identity) : new Response(null, { status: 503 }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const pending = yield* service.prepare(record).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("6 minutes");
    ready = true;
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success).toEqual(identity);

    ready = false;
    const unavailable = yield* service.prepare(record).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(unavailable)).toMatchObject({
      stage: "readiness",
      reason: "guest-failed",
    });
  }).pipe(Effect.scoped),
);
