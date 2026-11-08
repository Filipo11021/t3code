import type {
  ContainerDestination,
  ContainerSettings,
  ContainerSetup,
  ConfigureProjectContainerInput,
  ContainerOperationId,
  ContainerSubmissionInput,
  ContainerSubmissionStatus,
  ProjectContainerSetupRecord,
  ServerProvider,
} from "@t3tools/contracts";
import {
  containerCapturesEqual,
  containerRequestIssued,
  type ContainerCapture,
  type ContainerDraftState,
  type PendingContainerDraft,
} from "./draftState";
import type { ComposerSubmissionIntent } from "../../composer-logic";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";

export function containerSendEntry<Annotation>(input: {
  readonly intercept: (request: {
    dispatchMode: ComposerDispatchMode;
    submissionIntent: ComposerSubmissionIntent;
    directAnnotation: boolean;
  }) => Promise<boolean>;
  readonly onHostSend: (
    dispatchMode: ComposerDispatchMode,
    submissionIntent: ComposerSubmissionIntent,
    annotation?: Annotation,
  ) => Promise<void>;
}) {
  return async (
    event?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    annotation?: Annotation,
  ) => {
    event?.preventDefault();
    if (
      await input.intercept({
        dispatchMode,
        submissionIntent,
        directAnnotation: annotation !== undefined,
      })
    )
      return;
    await input.onHostSend(dispatchMode, submissionIntent, annotation);
  };
}

type Intent = ContainerDraftState["intent"];
export type ContainerLiveSource = {
  readonly source: Intent["source"];
  readonly capture: Omit<ContainerCapture, "submissionIntent">;
  readonly refusal: string | null;
};
export function createContainerSubmission(deps: {
  readonly state: () => ContainerDraftState | null;
  readonly read: () => ContainerLiveSource;
  readonly hydrated: () => boolean;
  readonly supported: () => boolean;
  readonly write: (state: ContainerDraftState | null) => void;
  readonly persist: (state: PendingContainerDraft) => Promise<void>;
  readonly settings: (intent: Intent) => Promise<ContainerSettings>;
  readonly save: (
    input: ConfigureProjectContainerInput,
    source: Intent["source"],
  ) => Promise<ProjectContainerSetupRecord["revision"]>;
  readonly open: (
    intent: Intent,
    revision: ProjectContainerSetupRecord["revision"] | null,
  ) => Promise<ContainerDestination>;
  readonly connect: (
    destination: ContainerDestination,
  ) => Promise<{ readonly providers: ReadonlyArray<ServerProvider>; readonly supported: boolean }>;
  readonly format: (capture: ContainerCapture, provider: ServerProvider) => string;
  readonly submit: (
    destination: ContainerDestination,
    request: ContainerSubmissionInput,
  ) => Promise<ContainerSubmissionStatus>;
  readonly inspect: (
    destination: ContainerDestination,
    request: ContainerSubmissionInput,
  ) => Promise<ContainerSubmissionStatus>;
  readonly navigate: (
    destination: ContainerDestination,
    threadId: Extract<ContainerSubmissionStatus, { kind: "accepted" }>["threadId"],
  ) => Promise<void>;
  readonly clear: () => void;
  readonly error: (message: string) => void;
}) {
  let generation = 0;
  let busy = false;
  const valid = (token: number, intent: Intent) =>
    generation === token && deps.state()?.intent.operationId === intent.operationId;
  const fence = (token: number, intent: Intent) => {
    if (!valid(token, intent))
      throw new Error("Container continuation cancelled. The source is unchanged.");
  };
  const unchanged = (pending: PendingContainerDraft) => {
    const live = deps.read();
    return (
      live.refusal === null &&
      live.source.environmentId === pending.intent.source.environmentId &&
      live.source.projectId === pending.intent.source.projectId &&
      live.source.checkoutPath === pending.intent.source.checkoutPath &&
      containerCapturesEqual(
        { ...live.capture, submissionIntent: pending.captured.submissionIntent },
        pending.captured,
      )
    );
  };
  const write = (token: number, pending: PendingContainerDraft) => {
    fence(token, pending.intent);
    deps.write(pending);
  };
  const resolveSetup = async (token: number, pending: PendingContainerDraft) => {
    const settings = await deps.settings(pending.intent);
    fence(token, pending.intent);
    if (!settings.project)
      throw new Error("Update the host server to support project container setup.");
    if (!settings.project.setup) {
      write(token, {
        ...pending,
        error: null,
        progress: { kind: "setup", seed: settings.config, revision: null },
      });
      return null;
    }
    return settings.project.setup.revision;
  };
  const finish = async (token: number, pending: PendingContainerDraft) => {
    if (pending.progress.kind !== "accepted" || pending.progress.status.kind !== "accepted") return;
    if (pending.captured.submissionIntent === "foreground") {
      await deps.navigate(pending.progress.destination, pending.progress.status.threadId);
      fence(token, pending.intent);
    }
    if (unchanged(pending)) deps.clear();
    if (
      pending.captured.submissionIntent === "foreground" &&
      pending.progress.status.preparation !== "preparing" &&
      pending.progress.status.preparation !== "blocked"
    )
      deps.write(null);
  };
  const issue = async (
    token: number,
    pending: PendingContainerDraft,
    repeat: boolean,
    requireUnchanged = false,
  ) => {
    if (pending.progress.kind !== "request-issued" && pending.progress.kind !== "accepted") return;
    const { destination, request } = pending.progress;
    fence(token, pending.intent);
    if (repeat) {
      await deps.persist(pending);
      fence(token, pending.intent);
      if (requireUnchanged && !unchanged(pending))
        throw new Error(
          "The source changed before dispatch. The frozen request is retained for explicit inspection or continuation.",
        );
    }
    const status = await (repeat
      ? deps.submit(destination, request)
      : deps.inspect(destination, request));
    fence(token, pending.intent);
    if (status.kind === "accepted") {
      const accepted: PendingContainerDraft = {
        ...pending,
        error: null,
        progress: { kind: "accepted", destination, request, status },
      };
      await deps.persist(accepted);
      fence(token, pending.intent);
      await finish(token, accepted);
    } else if (status.kind === "rejected") {
      await deps.persist({
        ...pending,
        error: status.reason,
        progress: { kind: "rejected", destination, request, reason: status.reason },
      });
      fence(token, pending.intent);
    } else {
      write(token, {
        ...pending,
        error:
          status.kind === "conflict" || status.kind === "provider-required"
            ? status.reason
            : "The original Send is unresolved. Continue repeats only that frozen request. Reload never sends it automatically.",
      });
    }
  };
  const prepare = async (
    token: number,
    pending: PendingContainerDraft,
    revision: ProjectContainerSetupRecord["revision"] | null,
  ) => {
    if (!unchanged(pending))
      throw new Error(
        "The source changed during setup. Send again to use the edited prompt. Saved project setup is retained.",
      );
    write(token, { ...pending, progress: { kind: "opening", revision }, error: null });
    const destination = await deps.open(pending.intent, revision);
    fence(token, pending.intent);
    if (
      destination.hostEnvironmentId !== pending.intent.source.environmentId ||
      destination.guestEnvironmentId === destination.hostEnvironmentId
    )
      throw new Error("The container destination identity changed.");
    const providerPending: PendingContainerDraft = {
      ...pending,
      progress: { kind: "provider-required", destination },
      error: null,
    };
    write(token, providerPending);
    const guest = await deps.connect(destination);
    fence(token, pending.intent);
    if (!guest.supported)
      throw new Error("Update the guest server before sending into this container.");
    const provider = guest.providers.find(
      (candidate) => candidate.driver === pending.captured.driver && candidate.enabled,
    );
    if (!provider?.installed || provider.auth.status !== "authenticated")
      throw new Error(
        "Install and sign in to the selected provider in the guest, then Continue. Your source is unchanged.",
      );
    if (
      provider.models.length > 0 &&
      !provider.models.some(
        (model) =>
          model.slug === pending.captured.modelSelection.model ||
          model.aliases?.includes(pending.captured.modelSelection.model),
      )
    )
      throw new Error(
        "The selected model is unavailable in this guest. Your source and model options are unchanged.",
      );
    if (!unchanged(pending))
      throw new Error("The source changed during setup. Send again to use the edited prompt.");
    const issued: PendingContainerDraft = {
      ...pending,
      error: null,
      progress: {
        kind: "request-issued",
        destination,
        request: {
          operationId: pending.intent.operationId,
          message: {
            projectId: destination.guestProjectId,
            text: deps.format(pending.captured, provider),
            modelSelection: { ...pending.captured.modelSelection, instanceId: provider.instanceId },
            runtimeMode: pending.captured.runtimeMode,
            interactionMode: pending.captured.interactionMode,
          },
        },
      },
    };
    fence(token, pending.intent);
    await issue(token, issued, true, true);
  };
  const run = async (work: (token: number) => Promise<void>) => {
    if (busy) return;
    busy = true;
    const token = generation;
    try {
      await work(token);
    } catch (cause) {
      if (token !== generation) return;
      const message =
        cause instanceof Error ? cause.message : "Container Send failed. The source is unchanged.";
      const current = deps.state();
      if (current?.kind === "pending") deps.write({ ...current, error: message });
      deps.error(message);
    } finally {
      if (generation === token) busy = false;
    }
  };
  return {
    invalidate: () => {
      generation++;
      busy = false;
    },
    intercept: async (input: {
      dispatchMode: string;
      submissionIntent: ContainerCapture["submissionIntent"] | "alternate";
      directAnnotation: boolean;
    }) => {
      if (!deps.hydrated()) return true;
      const state = deps.state();
      if (!state) return false;
      await run(async (token) => {
        if (state.kind === "pending" && state.progress.kind === "rejected")
          throw new Error(
            "The guest rejected the original Send. Choose a corrected Send explicitly; its source is unchanged.",
          );
        if (state.kind === "pending" && state.progress.kind === "setup" && state.error === null)
          return;
        if (containerRequestIssued(state) && state.kind === "pending") {
          if (state.progress.kind === "accepted") await finish(token, state);
          else await issue(token, state, false);
          return;
        }
        if (!deps.supported())
          throw new Error(
            "Container workspaces are unavailable or turned off in Settings. Choose Local or turn the feature back on.",
          );
        const live = deps.read();
        if (
          live.source.environmentId !== state.intent.source.environmentId ||
          live.source.projectId !== state.intent.source.projectId ||
          live.source.checkoutPath !== state.intent.source.checkoutPath
        )
          throw new Error(
            "This container choice belongs to another source. Choose its workspace again.",
          );
        if (
          input.directAnnotation ||
          input.dispatchMode !== "auto" ||
          input.submissionIntent === "alternate"
        )
          throw new Error(
            "This first container Send supports ordinary foreground or background text dispatch only.",
          );
        if (live.refusal) throw new Error(live.refusal);
        if (!live.capture.text.trim())
          throw new Error("Enter a prompt before sending into a container.");
        const pending: PendingContainerDraft = {
          kind: "pending",
          intent: state.intent,
          captured: { ...live.capture, submissionIntent: input.submissionIntent },
          error: null,
          progress: { kind: "opening", revision: null },
        };
        write(token, pending);
        if (state.intent.choice.type === "existing") {
          await prepare(token, pending, null);
          return;
        }
        const revision = await resolveSetup(token, pending);
        if (revision) await prepare(token, pending, revision);
      });
      return true;
    },
    confirm: (setup: ContainerSetup) =>
      run(async (token) => {
        const state = deps.state();
        if (state?.kind !== "pending" || state.progress.kind !== "setup") return;
        const revision = await deps.save(
          {
            kind: "setup",
            projectId: state.intent.source.projectId,
            expectedRevision: state.progress.revision,
            value: setup,
          },
          state.intent.source,
        );
        fence(token, state.intent);
        await prepare(token, state, revision);
      }),
    reloadSetup: () =>
      run(async (token) => {
        const state = deps.state();
        if (state?.kind !== "pending" || state.progress.kind !== "setup") return;
        const settings = await deps.settings(state.intent);
        fence(token, state.intent);
        if (!settings.project) throw new Error("Project container settings are unavailable.");
        write(token, {
          ...state,
          error: null,
          progress: {
            kind: "setup",
            seed: settings.project.setup?.value ?? settings.config,
            revision: settings.project.setup?.revision ?? null,
          },
        });
      }),
    continueOriginal: () =>
      run(async (token) => {
        const state = deps.state();
        if (state?.kind !== "pending") return;
        if (state.progress.kind === "request-issued") await issue(token, state, true);
        else if (state.progress.kind === "accepted") {
          if (
            state.progress.status.kind === "accepted" &&
            state.progress.status.preparation !== "released"
          )
            await issue(token, state, true);
          else await finish(token, state);
        } else if (
          state.progress.kind === "opening" &&
          state.intent.choice.type === "fresh" &&
          state.progress.revision === null
        ) {
          const revision = await resolveSetup(token, state);
          if (revision) await prepare(token, state, revision);
        } else if (state.progress.kind !== "setup" && state.progress.kind !== "rejected")
          await prepare(
            token,
            state,
            state.progress.kind === "opening" ? state.progress.revision : null,
          );
      }),
    inspect: () =>
      run(async (token) => {
        const state = deps.state();
        if (state?.kind === "pending" && containerRequestIssued(state))
          await issue(token, state, false);
      }),
    openAccepted: () =>
      run(async (token) => {
        const state = deps.state();
        if (state?.kind === "pending")
          await finish(token, {
            ...state,
            captured: { ...state.captured, submissionIntent: "foreground" },
          });
      }),
    correctRejected: (operationId: ContainerOperationId) => {
      const state = deps.state();
      if (state?.kind !== "pending" || state.progress.kind !== "rejected") return;
      generation++;
      busy = false;
      deps.write({
        kind: "selected",
        intent: {
          ...state.intent,
          operationId,
          choice: { type: "existing", workspaceId: state.progress.destination.workspaceId },
        },
      });
    },
    cancel: () => {
      generation++;
      busy = false;
      const state = deps.state();
      if (state?.kind !== "pending") return;
      if (state.progress.kind === "rejected") return;
      deps.write(
        containerRequestIssued(state)
          ? {
              ...state,
              error:
                "Stopped waiting. The original message may already be accepted. Inspect or open its guest thread.",
            }
          : { kind: "selected", intent: state.intent },
      );
    },
  };
}
