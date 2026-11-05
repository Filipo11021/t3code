import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersistedConnectionTarget, SavedConnectionTarget } from "../connection/model.ts";
import { connectionRouteId } from "../connection/routes.ts";
import {
  ConnectionCatalogDocument,
  type ConnectionCatalogState,
} from "../platform/storageDocument.ts";
import { ContainerConnectionTarget } from "./target.ts";

const StoredContainerRoute = Schema.Struct({
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  target: ContainerConnectionTarget,
});
const ContainerConnections = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  routes: Schema.Array(StoredContainerRoute),
});
type StoredContainerRoute = typeof StoredContainerRoute.Type;

const RawCatalog = Schema.Struct({
  ...ConnectionCatalogDocument.fields,
  targets: Schema.Array(Schema.Unknown),
  containerConnections: Schema.optionalKey(Schema.Unknown),
});
const CatalogEnvelope = Schema.Struct({
  ...ConnectionCatalogDocument.fields,
  containerConnections: Schema.optionalKey(ContainerConnections),
});
const ContainerTag = Schema.TaggedStruct("ContainerConnectionTarget", {});
const isContainerTag = Schema.is(ContainerTag);
const decodeRaw = Schema.decodeEffect(Schema.fromJsonString(RawCatalog));
const decodeOrdinary = Schema.decodeUnknownEffect(ConnectionCatalogDocument);
const decodeFeature = Schema.decodeUnknownOption(ContainerConnections);
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(CatalogEnvelope));

function routeKey(target: ContainerConnectionTarget): string {
  return JSON.stringify([target.environmentId, connectionRouteId(target)]);
}

function validPositions(routes: ReadonlyArray<StoredContainerRoute>, retainedCount: number) {
  const positions = new Set<number>();
  const identities = new Set<string>();
  for (const { position, target } of routes) {
    const key = routeKey(target);
    if (
      position >= retainedCount + routes.length ||
      positions.has(position) ||
      identities.has(key)
    ) {
      return false;
    }
    positions.add(position);
    identities.add(key);
  }
  return true;
}

function insertRoutes(
  targets: ReadonlyArray<SavedConnectionTarget>,
  routes: ReadonlyArray<StoredContainerRoute>,
) {
  const merged = [...targets];
  for (const { position, target } of [...routes].sort((a, b) => a.position - b.position)) {
    merged.splice(position, 0, target);
  }
  return merged;
}

export const encodeConnectionCatalog = Effect.fn("containers.encodeConnectionCatalog")(function* (
  state: ConnectionCatalogState,
) {
  const targets: Array<PersistedConnectionTarget> = [];
  const routes: Array<StoredContainerRoute> = [];
  state.targets.forEach((target, position) => {
    if (target._tag === "ContainerConnectionTarget") routes.push({ position, target });
    else targets.push(target);
  });
  return yield* encodeEnvelope({
    ...state,
    targets,
    ...(routes.length === 0 ? {} : { containerConnections: { schemaVersion: 1, routes } }),
  });
});

export const decodeConnectionCatalog = Effect.fn("containers.decodeConnectionCatalog")(function* (
  raw: string,
): Effect.fn.Return<
  { readonly state: ConnectionCatalogState; readonly repair?: string },
  Schema.SchemaError
> {
  const envelope = yield* decodeRaw(raw);
  const ordinaryTargets: Array<unknown> = [];
  const legacyRoutes: Array<{ readonly position: number; readonly target: unknown }> = [];
  envelope.targets.forEach((target, position) => {
    if (isContainerTag(target)) legacyRoutes.push({ position, target });
    else ordinaryTargets.push(target);
  });
  const ordinary = yield* decodeOrdinary({ ...envelope, targets: ordinaryTargets });
  let targets: ReadonlyArray<SavedConnectionTarget> = ordinary.targets;
  if (legacyRoutes.length > 0) {
    const legacy = decodeFeature({ schemaVersion: 1, routes: legacyRoutes });
    if (Option.isSome(legacy) && validPositions(legacy.value.routes, ordinary.targets.length)) {
      targets = insertRoutes(targets, legacy.value.routes);
    } else {
      yield* Effect.logWarning("Ignoring invalid legacy container connection metadata.");
    }
  }
  if (envelope.containerConnections !== undefined) {
    const feature = decodeFeature(envelope.containerConnections);
    if (Option.isSome(feature)) {
      const extensionKeys = new Set(feature.value.routes.map(({ target }) => routeKey(target)));
      const remaining = targets.filter(
        (target) =>
          target._tag !== "ContainerConnectionTarget" || !extensionKeys.has(routeKey(target)),
      );
      if (validPositions(feature.value.routes, remaining.length)) {
        targets = insertRoutes(remaining, feature.value.routes);
      } else {
        yield* Effect.logWarning("Ignoring conflicting container connection positions.");
      }
    } else {
      yield* Effect.logWarning("Ignoring invalid or unsupported container connection metadata.");
    }
  }
  const state: ConnectionCatalogState = { ...ordinary, targets };
  return {
    state,
    ...(legacyRoutes.length === 0 ? {} : { repair: yield* encodeConnectionCatalog(state) }),
  };
});
