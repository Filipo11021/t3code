import { describe, expect, it } from "@effect/vitest";
import { ContainerWorkspaceId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
} from "../platform/storageDocument.ts";
import { ContainerConnectionRegistration, ContainerConnectionTarget } from "./target.ts";
import { decodeConnectionCatalog, encodeConnectionCatalog } from "./catalog.ts";

// Frozen document and union membership from 8b44f42b14c8e273156474a924ccf29680dd7857; ordinary leaf schemas are unchanged.
const OldConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(
    Schema.Union([BearerConnectionTarget, RelayConnectionTarget, SshConnectionTarget]),
  ),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(
    Schema.Struct({ connectionId: Schema.String, credential: ConnectionCredential }),
  ),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
const oldJson = Schema.fromJsonString(OldConnectionCatalogDocument);

const hostId = EnvironmentId.make("host");
const guestId = EnvironmentId.make("guest");
const bearer = new BearerConnectionTarget({
  environmentId: hostId,
  connectionId: "host-lan",
  label: "Host",
});
const relay = new RelayConnectionTarget({ environmentId: hostId, label: "Host relay" });
const ssh = new SshConnectionTarget({
  environmentId: EnvironmentId.make("other"),
  connectionId: "other-ssh",
  label: "SSH",
});
const guest = new ContainerConnectionTarget({
  environmentId: guestId,
  hostEnvironmentId: hostId,
  workspaceId: ContainerWorkspaceId.make("workspace"),
  label: "Ubuntu",
});

function ordinaryCatalog() {
  const host = registerConnectionInCatalog(
    EMPTY_CONNECTION_CATALOG_DOCUMENT,
    new BearerConnectionRegistration({
      target: bearer,
      profile: new BearerConnectionProfile({
        environmentId: bearer.environmentId,
        connectionId: bearer.connectionId,
        label: bearer.label,
        httpBaseUrl: "https://host.test",
        wsBaseUrl: "wss://host.test",
      }),
      credential: new BearerConnectionCredential({ token: "host-secret" }),
    }),
    [bearer, relay],
  );
  const registered = registerConnectionInCatalog(
    host,
    new SshConnectionRegistration({
      target: ssh,
      profile: new SshConnectionProfile({
        environmentId: ssh.environmentId,
        connectionId: ssh.connectionId,
        label: ssh.label,
        target: { alias: "other", hostname: "other.test", username: "dev", port: 22 },
      }),
      credential: new BearerConnectionCredential({ token: "ssh-secret" }),
    }),
  );
  return {
    ...registered,
    remoteDpopTokens: [
      new TokenStore.RemoteDpopAccessToken({
        environmentId: hostId,
        label: "Host",
        endpoint: {
          httpBaseUrl: "https://relay.test",
          wsBaseUrl: "wss://relay.test",
          providerKind: "cloudflare_tunnel",
        },
        accessToken: "dpop-secret",
        expiresAtEpochMs: 1_000_000,
        dpopThumbprint: "thumbprint",
      }),
    ],
    githubRoutingPermissions: [
      { environmentId: hostId, connectionKey: "host-routes", permission: "read-write" as const },
    ],
    disabledEnvironmentIds: [ssh.environmentId, guestId],
  };
}

describe("container catalog compatibility", () => {
  it.effect("preserves ordinary records through an exact pre-feature reader and writer", () =>
    Effect.gen(function* () {
      const ordinary = ordinaryCatalog();
      const registered = registerConnectionInCatalog(
        ordinary,
        new ContainerConnectionRegistration({ target: guest }),
      );
      const raw = yield* encodeConnectionCatalog(registered);
      expect((yield* decodeConnectionCatalog(raw)).state).toEqual(registered);
      const oldRead = yield* Schema.decodeEffect(oldJson)(raw);
      expect(oldRead).toEqual(ordinary);
      const oldSave = yield* Schema.encodeEffect(oldJson)({
        ...oldRead,
        disabledEnvironmentIds: [...oldRead.disabledEnvironmentIds, hostId],
      });
      expect(yield* Schema.decodeEffect(oldJson)(oldSave)).toEqual({
        ...ordinary,
        disabledEnvironmentIds: [...ordinary.disabledEnvironmentIds, hostId],
      });
      expect((yield* decodeConnectionCatalog(oldSave)).state).toEqual({
        ...ordinary,
        disabledEnvironmentIds: [...ordinary.disabledEnvironmentIds, hostId],
      });
    }),
  );

  it.effect("retains unified ordering and disabled choices through route changes and reload", () =>
    Effect.gen(function* () {
      const ordinary = ordinaryCatalog();
      const hostContainer = new ContainerConnectionTarget({ ...guest, environmentId: hostId });
      const secondGuest = new ContainerConnectionTarget({
        ...guest,
        workspaceId: ContainerWorkspaceId.make("second-workspace"),
      });
      const mixed = {
        ...ordinary,
        targets: [guest, bearer, hostContainer, relay, secondGuest, ssh],
      };
      expect((yield* decodeConnectionCatalog(yield* encodeConnectionCatalog(mixed))).state).toEqual(
        mixed,
      );
      const disabled = setConnectionEnabledInCatalog(mixed, guestId, false);
      const registered = registerConnectionInCatalog(
        disabled,
        new ContainerConnectionRegistration({ target: guest }),
        [secondGuest, guest],
      );
      const reordered = setRoutesInCatalog(registered, hostId, [relay, hostContainer, bearer]);
      const reloaded = yield* decodeConnectionCatalog(yield* encodeConnectionCatalog(reordered));
      expect(reloaded.state).toEqual(reordered);
      expect(reloaded.state.targets).toEqual([
        secondGuest,
        guest,
        relay,
        hostContainer,
        bearer,
        ssh,
      ]);
      expect(reloaded.state.disabledEnvironmentIds).toEqual(ordinary.disabledEnvironmentIds);
      expect(reloaded.state.credentials).toEqual(ordinary.credentials);
      expect(reloaded.repair).toBeUndefined();

      const enabled = setConnectionEnabledInCatalog(reloaded.state, guestId, true);
      const removed = removeConnectionFromCatalog(enabled, guestId);
      const raw = yield* encodeConnectionCatalog(removed);
      expect((yield* decodeConnectionCatalog(raw)).state).toEqual({
        ...reordered,
        targets: [relay, hostContainer, bearer, ssh],
        disabledEnvironmentIds: [ssh.environmentId],
      });
      expect((yield* Schema.decodeEffect(oldJson)(raw)).credentials).toEqual(ordinary.credentials);

      const ordinaryOnly = setRoutesInCatalog(removed, hostId, [relay, bearer]);
      const ordinaryRaw = yield* encodeConnectionCatalog(ordinaryOnly);
      expect(ordinaryRaw).not.toContain("containerConnections");
      expect((yield* decodeConnectionCatalog(ordinaryRaw)).state).toEqual(ordinaryOnly);
    }),
  );

  it.effect.each([
    { name: "absent", extension: undefined },
    { name: "malformed", extension: null },
    { name: "future", extension: { schemaVersion: 999, routes: [] } },
    {
      name: "invalid target",
      extension: { schemaVersion: 1, routes: [{ position: 0, target: {} }] },
    },
    {
      name: "duplicate position",
      extension: {
        schemaVersion: 1,
        routes: [
          { position: 0, target: guest },
          { position: 0, target: guest },
        ],
      },
    },
    {
      name: "duplicate route",
      extension: {
        schemaVersion: 1,
        routes: [
          { position: 0, target: guest },
          { position: 1, target: guest },
        ],
      },
    },
    {
      name: "negative position",
      extension: { schemaVersion: 1, routes: [{ position: -1, target: guest }] },
    },
    {
      name: "fractional position",
      extension: { schemaVersion: 1, routes: [{ position: 0.5, target: guest }] },
    },
    {
      name: "out-of-range position",
      extension: { schemaVersion: 1, routes: [{ position: 4, target: guest }] },
    },
  ])("keeps ordinary records with $name feature metadata", ({ extension }) =>
    Effect.gen(function* () {
      const ordinary = ordinaryCatalog();
      const raw = JSON.stringify({ ...ordinary, containerConnections: extension });
      const decoded = yield* decodeConnectionCatalog(raw);
      expect(decoded).toEqual({ state: ordinary });
      expect(
        yield* Schema.decodeEffect(oldJson)(yield* encodeConnectionCatalog(decoded.state)),
      ).toEqual(ordinary);
    }),
  );

  it.effect(
    "repairs legacy mixed targets before the next save and merges extension routes by identity",
    () =>
      Effect.gen(function* () {
        const ordinary = ordinaryCatalog();
        const secondGuest = new ContainerConnectionTarget({
          ...guest,
          workspaceId: ContainerWorkspaceId.make("second-workspace"),
        });
        const mixed = { ...ordinary, targets: [guest, bearer, relay, secondGuest, ssh] };
        const decoded = yield* decodeConnectionCatalog(JSON.stringify(mixed));
        expect(decoded.state).toEqual(mixed);
        expect(decoded.repair).toBeDefined();
        const repaired = decoded.repair!;
        expect(yield* Schema.decodeEffect(oldJson)(repaired)).toEqual(ordinary);
        expect(yield* decodeConnectionCatalog(repaired)).toEqual({ state: mixed });

        const renamed = new ContainerConnectionTarget({ ...guest, label: "Renamed" });
        const merged = yield* decodeConnectionCatalog(
          JSON.stringify({
            ...mixed,
            containerConnections: { schemaVersion: 1, routes: [{ position: 3, target: renamed }] },
          }),
        );
        expect(merged.state).toEqual({
          ...mixed,
          targets: [bearer, relay, secondGuest, renamed, ssh],
        });
        expect(yield* decodeConnectionCatalog(merged.repair!)).toEqual({ state: merged.state });
      }),
  );

  it.effect(
    "contains malformed legacy container rows without accepting unknown ordinary tags",
    () =>
      Effect.gen(function* () {
        const ordinary = ordinaryCatalog();
        const decoded = yield* decodeConnectionCatalog(
          JSON.stringify({
            ...ordinary,
            targets: [{ _tag: "ContainerConnectionTarget" }, ...ordinary.targets],
            containerConnections: { schemaVersion: 999 },
          }),
        );
        expect(decoded.state).toEqual(ordinary);
        expect(yield* Schema.decodeEffect(oldJson)(decoded.repair!)).toEqual(ordinary);
        for (const target of [{ _tag: "FutureOrdinaryTarget" }, { ...bearer, connectionId: 1 }]) {
          const error = yield* decodeConnectionCatalog(
            JSON.stringify({
              ...ordinary,
              targets: [...ordinary.targets, target],
              containerConnections: null,
            }),
          ).pipe(Effect.flip);
          expect(error.message).toContain('["targets"][3]');
        }
      }),
  );
});
