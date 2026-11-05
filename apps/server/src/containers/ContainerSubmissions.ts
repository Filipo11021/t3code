import {
  CommandId,
  ContainerError,
  ContainerGuestMessage,
  ContainerSubmissionInput,
  type ContainerSubmissionStatus,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Registry from "./registry.ts";

const sameMessage = Schema.toEquivalence(ContainerGuestMessage);
const decodeInput = Schema.decodeEffect(ContainerSubmissionInput);
const decodeRecord = Schema.decodeEffect(Registry.SubmissionRecord);
const conflict = {
  kind: "conflict",
  reason: "This operation is bound to a different guest launch.",
} as const;

export class ContainerSubmissions extends Context.Service<
  ContainerSubmissions,
  {
    readonly submit: (
      input: ContainerSubmissionInput,
    ) => Effect.Effect<ContainerSubmissionStatus, ContainerError>;
    readonly inspect: (
      input: ContainerSubmissionInput,
    ) => Effect.Effect<ContainerSubmissionStatus, ContainerError>;
  }
>()("t3/containers/ContainerSubmissions") {}

const make = Effect.gen(function* () {
  const registry = yield* Registry.ContainerRegistry;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const locks = yield* KeyedLock.make<string>();
  const guest = yield* Config.String("T3CODE_CONTAINER_GUEST").pipe(Config.withDefault("0"));
  const guard =
    guest === "1"
      ? Effect.void
      : Effect.fail(new ContainerError({ stage: "guest-only", reason: "incompatible" }));
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) => new ContainerError({ stage: "submission", reason: "guest-failed", cause }),
      ),
    );
  const inspectRecord = Effect.fn("ContainerSubmissions.inspectRecord")(function* (
    record: Registry.SubmissionRecord,
  ): Effect.fn.Return<ContainerSubmissionStatus, ContainerError> {
    const launch = record.launch;
    const creation = yield* receipts.getByCommandId(launch.commandId).pipe(wrap);
    const initialId = CommandId.make(`${launch.commandId}:initial-message`);
    const initial = yield* receipts.getByCommandId(initialId).pipe(wrap);
    if (Option.isNone(creation)) return Option.isNone(initial) ? { kind: "reserved" } : conflict;
    if (
      creation.value.threadId !== launch.threadId ||
      creation.value.commandType !== "thread.create"
    )
      return conflict;
    if (creation.value.status === "rejected")
      return Option.isNone(initial)
        ? { kind: "rejected", reason: "Guest thread creation was rejected." }
        : conflict;
    const shell = yield* threads.getThreadShell(launch.threadId).pipe(wrap);
    if (!shell || shell.projectId !== launch.projectId) return conflict;
    if (Option.isNone(initial)) return { kind: "thread-created", threadId: launch.threadId };
    if (
      initial.value.threadId !== launch.threadId ||
      initial.value.commandType !== "message.dispatch"
    )
      return conflict;
    const stored = yield* events
      .readByCommandId({ commandId: initialId })
      .pipe(Stream.runCollect, wrap);
    const run = stored.find((entry) => entry.event.type === "run.created")?.event;
    const message = stored.find((entry) => entry.event.type === "message.updated")?.event;
    if (initial.value.status === "rejected")
      return run
        ? conflict
        : { kind: "rejected", reason: "The initial guest message was rejected." };
    if (
      run?.type !== "run.created" ||
      message?.type !== "message.updated" ||
      run.threadId !== launch.threadId ||
      message.threadId !== launch.threadId ||
      message.payload.id !== launch.initialMessage.messageId ||
      message.payload.text !== launch.initialMessage.text
    )
      return conflict;
    const projection = yield* threads
      .getThreadRecords(launch.threadId, ["runs"], { runIds: [run.payload.id] })
      .pipe(wrap);
    const current = projection.runs.find((candidate) => candidate.id === run.payload.id);
    if (!current) return conflict;
    const enabled = yield* threads.isProviderInstanceEnabledForProject({
      projectId: launch.projectId,
      instanceId: launch.modelSelection.instanceId,
    });
    return {
      kind: "accepted",
      threadId: launch.threadId,
      runId: run.payload.id,
      sequence: initial.value.resultSequence,
      preparation:
        current.status === "preparing" ? (enabled ? "preparing" : "blocked") : "released",
    };
  });
  const inspect = Effect.fn("ContainerSubmissions.inspect")(function* (
    input: ContainerSubmissionInput,
  ) {
    yield* guard;
    const record = yield* registry.submission(input.operationId);
    if (!record) return { kind: "unseen" } as const;
    if (!sameMessage(record.message, input.message)) return conflict;
    return yield* inspectRecord(record);
  });
  const submit = Effect.fn("ContainerSubmissions.submit")(function* (
    request: ContainerSubmissionInput,
  ) {
    yield* guard;
    const input = yield* decodeInput(request).pipe(wrap);
    return yield* locks.withLock(
      input.operationId,
      Effect.gen(function* () {
        let record = yield* registry.submission(input.operationId);
        if (record && !sameMessage(record.message, input.message)) return conflict;
        if (!record) {
          const provider = (yield* providers.getProviders).find(
            (candidate) => candidate.instanceId === input.message.modelSelection.instanceId,
          );
          if (
            !provider ||
            !provider.enabled ||
            !provider.installed ||
            provider.auth.status !== "authenticated" ||
            (provider.models.length > 0 &&
              !provider.models.some((model) => model.slug === input.message.modelSelection.model))
          ) {
            return {
              kind: "provider-required",
              reason:
                "Install and sign in to the selected provider in this guest, and choose an available model.",
            } as const;
          }
          const identity = `container-${input.operationId}`;
          record = yield* decodeRecord({
            operationId: input.operationId,
            message: input.message,
            launch: {
              commandId: CommandId.make(identity),
              threadId: ThreadId.make(identity),
              projectId: input.message.projectId,
              title: "New thread",
              generateTitle: true,
              modelSelection: input.message.modelSelection,
              runtimeMode: input.message.runtimeMode,
              interactionMode: input.message.interactionMode,
              workspaceStrategy: { type: "root" },
              initialMessage: {
                messageId: MessageId.make(identity),
                text: input.message.text,
                attachments: [],
              },
              createdBy: "user",
              creationSource: "web",
            },
          }).pipe(wrap);
          yield* registry.sealSubmission(record);
        }
        const before = yield* inspectRecord(record);
        if (
          before.kind === "conflict" ||
          before.kind === "rejected" ||
          (before.kind === "accepted" && before.preparation !== "preparing")
        )
          return before;
        const result = yield* launches.launch(record.launch).pipe(Effect.result);
        const after = yield* inspectRecord(record);
        if (after.kind === "accepted")
          return result._tag === "Failure" && after.preparation === "preparing"
            ? { ...after, preparation: "blocked" as const }
            : after;
        if (result._tag === "Failure")
          return yield* new ContainerError({
            stage: "launch",
            reason: "guest-failed",
            cause: result.failure,
          });
        return after;
      }),
    );
  });
  return ContainerSubmissions.of({ inspect, submit });
});
export const layer = Layer.effect(ContainerSubmissions, make);
