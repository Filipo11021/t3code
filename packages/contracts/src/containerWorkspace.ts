import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import { AuthEnvironmentMaintainScope, AuthStandardClientScopes } from "./auth.ts";

export const CONTAINER_GUEST_SCOPES = AuthStandardClientScopes.filter(
  (scope) =>
    !["relay:read", "relay:write", "access:read", "access:write", "environment:maintain"].includes(
      scope,
    ),
);
export const CONTAINER_HOST_SCOPES = [AuthEnvironmentMaintainScope, ...CONTAINER_GUEST_SCOPES];

export const ContainerWorkspaceId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  Schema.brand("ContainerWorkspaceId"),
);
export type ContainerWorkspaceId = typeof ContainerWorkspaceId.Type;
export const ContainerOperationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  Schema.brand("ContainerOperationId"),
);
export type ContainerOperationId = typeof ContainerOperationId.Type;

const Retention = Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))));
export const ContainerSetup = Schema.Struct({
  image: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  installScript: Schema.String,
  startScript: Schema.String,
  environment: Schema.Record(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
    Schema.String,
  ),
});
export type ContainerSetup = typeof ContainerSetup.Type;
export const ContainerConfig = Schema.Struct({
  ...ContainerSetup.fields,
  cleanup: Schema.Struct({ idleStopMinutes: Retention, removeAfterDays: Retention }),
});
export type ContainerConfig = typeof ContainerConfig.Type;
const CONTAINER_MAX_REMOVAL_DAYS = 3650;
const CONTAINER_MAX_IDLE_MINUTES = 525600;
const boundedRetention = (maximum: number) =>
  Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum }))));
export const ContainerCleanupRules = Schema.Struct({
  idleStopMinutes: boundedRetention(CONTAINER_MAX_IDLE_MINUTES),
  removeAfterDays: boundedRetention(CONTAINER_MAX_REMOVAL_DAYS),
});
export type ContainerCleanupRules = typeof ContainerCleanupRules.Type;
export const ContainerConfigWrite = Schema.Struct({
  ...ContainerSetup.fields,
  cleanup: ContainerCleanupRules,
});
export const ContainerConfigurationRevision = Schema.String.pipe(
  Schema.brand("ContainerConfigurationRevision"),
);
export const ProjectContainerCleanup = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("inherit") }),
  Schema.Struct({ kind: Schema.Literal("off") }),
  Schema.Struct({ kind: Schema.Literal("custom"), rules: ContainerCleanupRules }),
]);
export type ProjectContainerCleanup = typeof ProjectContainerCleanup.Type;
export const ProjectContainerSetupRecord = Schema.Struct({
  revision: ContainerConfigurationRevision,
  value: ContainerSetup,
});
export type ProjectContainerSetupRecord = typeof ProjectContainerSetupRecord.Type;
export const ProjectContainerCleanupRecord = Schema.Struct({
  revision: ContainerConfigurationRevision,
  value: ProjectContainerCleanup,
});
export type ProjectContainerCleanupRecord = typeof ProjectContainerCleanupRecord.Type;
export const ConfigureProjectContainerInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("setup"),
    projectId: ProjectId,
    expectedRevision: Schema.NullOr(ContainerConfigurationRevision),
    value: ContainerSetup,
  }),
  Schema.Struct({
    kind: Schema.Literal("cleanup"),
    projectId: ProjectId,
    expectedRevision: Schema.NullOr(ContainerConfigurationRevision),
    value: ProjectContainerCleanup,
  }),
]);
export type ConfigureProjectContainerInput = typeof ConfigureProjectContainerInput.Type;
export const DEFAULT_CONTAINER_CONFIG: ContainerConfig = {
  image: "ubuntu:26.04",
  installScript: "",
  startScript: "",
  environment: {},
  cleanup: { idleStopMinutes: null, removeAfterDays: null },
};

export const ContainerSelection = Schema.Union([
  Schema.Struct({ type: Schema.Literal("fresh") }),
  Schema.Struct({ type: Schema.Literal("existing"), workspaceId: ContainerWorkspaceId }),
]);
export type ContainerSelection = typeof ContainerSelection.Type;
export const OpenContainerInput = Schema.Struct({
  operationId: ContainerOperationId,
  projectId: ProjectId,
  checkoutPath: Schema.String,
  selection: ContainerSelection,
  setupRevision: Schema.optionalKey(ContainerConfigurationRevision),
});
export type OpenContainerInput = typeof OpenContainerInput.Type;
export const ContainerDestination = Schema.Struct({
  hostEnvironmentId: EnvironmentId,
  workspaceId: ContainerWorkspaceId,
  guestEnvironmentId: EnvironmentId,
  guestProjectId: ProjectId,
  guestCheckoutPath: Schema.String,
  label: Schema.String,
});
export type ContainerDestination = typeof ContainerDestination.Type;
export const ContainerStatus = Schema.Union([
  Schema.Struct({ type: Schema.Literal("provisioning"), stage: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ready"), destination: ContainerDestination }),
  Schema.Struct({ type: Schema.Literal("stopped") }),
  Schema.Struct({ type: Schema.Literal("failed"), stage: Schema.String, error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("removed"), retainedData: Schema.Literal(true) }),
]);
export type ContainerStatus = typeof ContainerStatus.Type;
export const ContainerWorkspace = Schema.Struct({
  id: ContainerWorkspaceId,
  ownership: Schema.Literals(["managed", "attached"]),
  projectId: ProjectId,
  checkoutPath: Schema.String,
  image: Schema.String,
  status: ContainerStatus,
  lastUsedAt: Schema.Number,
});
export type ContainerWorkspace = typeof ContainerWorkspace.Type;
export const ContainerActionInput = Schema.Struct({
  workspaceId: ContainerWorkspaceId,
  action: Schema.Literals(["stop", "restart", "remove-runtime"]),
});
export type ContainerActionInput = typeof ContainerActionInput.Type;
export const ContainerListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  checkoutPath: Schema.optionalKey(Schema.String),
});
export const ContainerSettings = Schema.Struct({
  config: ContainerConfig,
  workspaces: Schema.Array(ContainerWorkspace),
  available: Schema.Boolean,
  project: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      setup: Schema.NullOr(ProjectContainerSetupRecord),
      cleanup: Schema.NullOr(ProjectContainerCleanupRecord),
    }),
  ),
});
export type ContainerSettings = typeof ContainerSettings.Type;
export class ContainerError extends Schema.TaggedError<ContainerError>()("ContainerError", {
  stage: Schema.String,
  reason: Schema.Literals([
    "unavailable",
    "runtime-required",
    "engine-failed",
    "invalid-checkout",
    "invalid-environment",
    "incompatible",
    "not-found",
    "busy",
    "not-owned",
    "persistence",
    "guest-failed",
    "disabled",
    "setup-required",
    "configuration-conflict",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "runtime-required":
        return "A matching Linux T3 runtime is required. Set T3CODE_CONTAINER_RUNTIME to a complete runtime directory or archive built from this revision.";
      case "unavailable":
        return "Container engine unavailable. Install Docker or configure T3CODE_CONTAINER_ENGINE.";
      case "engine-failed":
        return `Container ${this.stage} failed. Check the container logs before retrying. Install retries may repeat partially completed work.`;
      case "invalid-checkout":
        return "The checkout or Git metadata cannot be safely mounted in a container.";
      case "invalid-environment":
        return "Container environment variables cannot override protected guest settings.";
      case "incompatible":
        return "The container no longer matches its recorded identity, mounts, or runtime.";
      case "not-found":
        return "Container workspace not found.";
      case "busy":
        return "The guest is busy or cannot prove it is idle. Stop running turns and close terminals before trying again.";
      case "not-owned":
        return "T3 does not manage this container. Its lifecycle is unchanged.";
      case "persistence":
        return "Container workspace state could not be saved.";
      case "guest-failed":
        return `The guest did not complete ${this.stage}. The source draft is unchanged.`;
      case "disabled":
        return "Container workspaces are unavailable inside a guest.";
      case "setup-required":
        return "Confirm this project's container environment before creating a container.";
      case "configuration-conflict":
        return "Container project settings changed. Reload them before continuing.";
    }
  }
}

export const CONTAINER_GATEWAY_PREFIX = "/api/container-gateway";
export const containerGatewayPath = (workspaceId: ContainerWorkspaceId) =>
  `${CONTAINER_GATEWAY_PREFIX}/${workspaceId}`;
