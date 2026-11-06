import {
  ContainerOperationId,
  ContainerSelection,
  ContainerDestination,
  ContainerSubmissionInput,
  ContainerSubmissionAccepted,
  ContainerSetup,
  ContainerConfigurationRevision,
  EnvironmentId,
  ProjectId,
  ModelSelection,
  ProviderDriverKind,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { modelSelectionsEqual } from "@t3tools/shared/model";

export const ContainerDraftIntent = Schema.Struct({
  operationId: ContainerOperationId,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    checkoutPath: Schema.String,
  }),
  choice: ContainerSelection,
});
export const ContainerCapture = Schema.Struct({
  text: Schema.String,
  modelSelection: ModelSelection,
  driver: ProviderDriverKind,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  effort: Schema.NullOr(Schema.String),
  submissionIntent: Schema.Literals(["foreground", "background"]),
});
export type ContainerCapture = typeof ContainerCapture.Type;
export const ContainerProgress = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("setup"),
    seed: ContainerSetup,
    revision: Schema.NullOr(ContainerConfigurationRevision),
  }),
  Schema.Struct({
    kind: Schema.Literal("opening"),
    revision: Schema.NullOr(ContainerConfigurationRevision),
  }),
  Schema.Struct({ kind: Schema.Literal("provider-required"), destination: ContainerDestination }),
  Schema.Struct({
    kind: Schema.Literal("request-issued"),
    destination: ContainerDestination,
    request: ContainerSubmissionInput,
  }),
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    destination: ContainerDestination,
    request: ContainerSubmissionInput,
    status: ContainerSubmissionAccepted,
  }),
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    destination: ContainerDestination,
    request: ContainerSubmissionInput,
    reason: Schema.String,
  }),
]);
export const ContainerDraftState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("selected"), intent: ContainerDraftIntent }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    intent: ContainerDraftIntent,
    captured: ContainerCapture,
    progress: ContainerProgress,
    error: Schema.NullOr(Schema.String),
  }),
]);
export type ContainerDraftState = typeof ContainerDraftState.Type;
export type PendingContainerDraft = Extract<ContainerDraftState, { kind: "pending" }>;
export const containerDraftStatesEqual = Schema.toEquivalence(Schema.NullOr(ContainerDraftState));
const sameCapture = Schema.toEquivalence(ContainerCapture);
export const containerCapturesEqual = (left: ContainerCapture, right: ContainerCapture) =>
  modelSelectionsEqual(left.modelSelection, right.modelSelection) &&
  sameCapture({ ...left, modelSelection: right.modelSelection }, right);
export const containerRequestIssued = (state: ContainerDraftState | null | undefined) =>
  state?.kind === "pending" &&
  (state.progress.kind === "request-issued" || state.progress.kind === "accepted");
