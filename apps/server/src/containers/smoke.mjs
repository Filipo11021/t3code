#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { WsRpcGroup } from "@t3tools/contracts";

const [host, credentialFile, projectId, checkoutPath] = process.argv.slice(2);
NodeAssert.ok(
  host && credentialFile && projectId && checkoutPath,
  "Usage: node apps/server/src/containers/smoke.mjs <host-origin> <host-token-file> <project-id> <checkout-path>",
);
const token = NodeFS.readFileSync(credentialFile, "utf8").trim();
const origin = new URL(host).origin;
async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
  NodeAssert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json();
}
async function socketUrl(prefix = "") {
  const ticket = await request(`${prefix}/api/auth/websocket-ticket/rpc`, { method: "POST" });
  const url = new URL(`${origin}${prefix}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket.ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return url.href;
}
function clientAt(url) {
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      retryPolicy: Schedule.recurs(0),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(Socket.layerWebSocket(url), RpcSerialization.layerJson).pipe(
        Layer.provide(NodeSocket.layerWebSocketConstructor),
      ),
    ),
  );
  return RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
}
const run = Effect.gen(function* () {
  const hostClient = yield* clientAt(yield* Effect.promise(() => socketUrl()));
  const input = {
    operationId: NodeCrypto.randomUUID(),
    projectId,
    checkoutPath,
    selection: { type: "fresh" },
  };
  const destination = yield* hostClient["containers.open"](input);
  const prefix = `/api/container-gateway/${destination.workspaceId}`;
  NodeAssert.equal(
    (yield* Effect.promise(() => fetch(`${origin}${prefix}/.well-known/t3/environment`))).status,
    401,
  );
  const descriptor = yield* Effect.promise(() => request(`${prefix}/.well-known/t3/environment`));
  NodeAssert.equal(descriptor.environmentId, destination.guestEnvironmentId);
  const guestClient = yield* clientAt(yield* Effect.promise(() => socketUrl(prefix)));
  const config = yield* guestClient["server.getConfig"]({});
  NodeAssert.equal(config.environment.environmentId, destination.guestEnvironmentId);
  const updates = yield* Stream.runCollect(
    guestClient.subscribeServerConfig({}).pipe(Stream.take(1)),
  );
  NodeAssert.equal(updates.length, 1);
  const reused = yield* hostClient["containers.open"]({
    ...input,
    operationId: NodeCrypto.randomUUID(),
    selection: { type: "existing", workspaceId: destination.workspaceId },
  });
  NodeAssert.equal(reused.guestEnvironmentId, destination.guestEnvironmentId);
  const engine = process.env.T3CODE_CONTAINER_ENGINE || "docker";
  const inspected = NodeChildProcess.spawnSync(
    engine,
    ["container", "inspect", `t3-workspace-${destination.workspaceId}`],
    { encoding: "utf8" },
  );
  NodeAssert.equal(inspected.status, 0);
  const [container] = JSON.parse(inspected.stdout);
  NodeAssert.equal(container.Config.Labels["codes.t3.workspace"], destination.workspaceId);
  NodeAssert.ok(!container.Mounts.some((mount) => mount.Destination === "/var/run/docker.sock"));
  const proof = NodeChildProcess.spawnSync(
    engine,
    [
      "exec",
      "--user",
      "t3",
      `t3-workspace-${destination.workspaceId}`,
      "sh",
      "-ec",
      'test "$(id -u)" != 0; grep -q "VERSION_ID=\\\"26.04\\\"" /etc/os-release; git status --porcelain >/dev/null; printf "ubuntu=26.04 uid=%s cwd=%s\\n" "$(id -u)" "$PWD"',
    ],
    { encoding: "utf8" },
  );
  NodeAssert.equal(proof.status, 0, proof.stderr);
  process.stdout.write(
    `${JSON.stringify({ workspaceId: destination.workspaceId, environmentId: destination.guestEnvironmentId, containerId: container.Id, runtime: proof.stdout.trim(), http: "authenticated", websocket: "streamed", reuse: "same identity", mounts: container.Mounts.map(({ Source, Destination }) => ({ source: Source, target: Destination })) }, null, 2)}\n`,
  );
});
run.pipe(Effect.scoped, NodeRuntime.runMain);
