import { describe, expect, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

const decodeOrdinaryCatalog = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

const ordinaryCatalog = {
  schemaVersion: 1,
  targets: [
    { _tag: "BearerConnectionTarget", environmentId: "host", label: "Host", connectionId: "lan" },
  ],
  profiles: [
    {
      _tag: "BearerConnectionProfile",
      environmentId: "host",
      label: "Host",
      connectionId: "lan",
      httpBaseUrl: "https://host.test",
      wsBaseUrl: "wss://host.test",
    },
  ],
  credentials: [
    { connectionId: "lan", credential: { _tag: "BearerConnectionCredential", token: "secret" } },
  ],
  remoteDpopTokens: [],
  disabledEnvironmentIds: ["host"],
};
const containerTarget = {
  _tag: "ContainerConnectionTarget",
  environmentId: "guest",
  hostEnvironmentId: "host",
  workspaceId: "workspace",
  label: "Ubuntu",
};

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect.each([
    { name: "invalid JSON", raw: "{not-json", corrupt: true },
    {
      name: "malformed feature metadata",
      raw: JSON.stringify({ ...ordinaryCatalog, containerConnections: null }),
      corrupt: false,
    },
    {
      name: "future feature metadata",
      raw: JSON.stringify({ ...ordinaryCatalog, containerConnections: { schemaVersion: 999 } }),
      corrupt: false,
    },
  ])("deletes only core corruption with $name", ({ raw, corrupt }) =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: raw,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      const loaded = yield* catalog.read;
      if (corrupt) expect(loaded.targets).toEqual([]);
      else expect(loaded).toEqual(ordinaryCatalog);
      expect(memory.deleted).toEqual(corrupt ? [CONNECTION_CATALOG_KEY] : []);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(corrupt ? undefined : raw);
    }),
  );

  it.effect(
    "fails legacy repair writes without deleting data, falling back, or caching unrepaired state",
    () =>
      Effect.gen(function* () {
        const legacy = JSON.stringify({
          ...ordinaryCatalog,
          targets: [containerTarget, ...ordinaryCatalog.targets],
        });
        const memory = makeStorage({
          [CONNECTION_CATALOG_KEY]: legacy,
          [LEGACY_CONNECTIONS_KEY]: "legacy data must not be read",
        });
        let fail = true;
        const writes: string[] = [];
        const storage = MobileSecureStorage.MobileSecureStorage.of({
          ...memory.storage,
          setItem: (key, value) =>
            Effect.gen(function* () {
              writes.push(value);
              if (fail)
                return yield* new MobileSecureStorage.MobileSecureStorageError({
                  operation: "write",
                  key,
                  cause: new Error("secure storage unavailable"),
                });
              yield* memory.storage.setItem(key, value);
            }),
        });
        const catalog = yield* make().pipe(
          Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
        );
        const error = yield* catalog.read.pipe(Effect.flip);
        expect(error.message).toContain("Could not save");
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(legacy);
        expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe("legacy data must not be read");
        expect(memory.deleted).toEqual([]);
        expect(writes).toHaveLength(1);

        fail = false;
        const loaded = yield* catalog.read;
        expect(loaded).toEqual({
          ...ordinaryCatalog,
          targets: [containerTarget, ...ordinaryCatalog.targets],
        });
        const raw = memory.values.get(CONNECTION_CATALOG_KEY)!;
        expect(decodeOrdinaryCatalog(raw)).toEqual(ordinaryCatalog);
        const restarted = yield* make().pipe(
          Effect.provideService(MobileSecureStorage.MobileSecureStorage, storage),
        );
        expect(yield* restarted.read).toEqual(loaded);
        expect(writes).toHaveLength(2);
        expect(memory.deleted).toEqual([]);
        expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe("legacy data must not be read");
      }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
