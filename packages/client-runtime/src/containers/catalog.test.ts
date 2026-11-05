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
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  setConnectionEnabledInCatalog,
} from "../platform/storageDocument.ts";
import { ContainerConnectionRegistration, ContainerConnectionTarget } from "./target.ts";

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
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));

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
      const raw = yield* encodeCatalog(registered);
      const oldRead = yield* Schema.decodeEffect(oldJson)(raw);
      expect(oldRead).toEqual(ordinary);
      const oldSave = yield* Schema.encodeEffect(oldJson)(
        setConnectionEnabledInCatalog(oldRead, hostId, false),
      );
      expect(yield* Schema.decodeEffect(oldJson)(oldSave)).toEqual({
        ...ordinary,
        disabledEnvironmentIds: [...ordinary.disabledEnvironmentIds, hostId],
      });
    }),
  );
});
