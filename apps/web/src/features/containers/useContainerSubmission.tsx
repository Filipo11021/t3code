import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  persistContainerDraft,
  useComposerDraftStore,
  type DraftId,
} from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useStableCallback } from "../../hooks/useStableCallback";
import { formatOutgoingPrompt } from "../../components/ChatView.logic";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/dialog";
import { ContainerEnvironmentSetup } from "./ContainerEnvironmentSetup";
import { createContainerSubmission, type ContainerLiveSource } from "./submission";
import { ContainerOperationId } from "@t3tools/contracts";
import { newDraftId } from "../../lib/utils";
import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";
import { parseCodexFeedbackCommand } from "@t3tools/client-runtime/state/threads";
import { parseSideChatCommand, parseStandaloneComposerSlashCommand } from "../../composer-logic";
import { environmentServerConfigsAtom } from "../../state/server";

type ContainerSourceSnapshot = {
  editor: ReturnType<ChatComposerHandle["getSendContext"]> | null | undefined;
  text: string | null;
  workspaceRoot: string | null;
  firstSendAllowed: boolean;
  providerDriver: import("@t3tools/contracts").ProviderDriverKind | null;
};
export function readContainerSource(
  draftId: DraftId,
  snapshot: ContainerSourceSnapshot,
): ContainerLiveSource {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  const draft = store.getComposerDraft(draftId);
  if (!session) throw new Error("The source draft is unavailable.");
  const pending = session.container?.kind === "pending" ? session.container : null;
  const live = snapshot.editor;
  const text = snapshot.text ?? draft?.prompt ?? "";
  const selection =
    live?.selectedModelSelection ??
    (draft?.activeProvider ? draft.modelSelectionByProvider[draft.activeProvider] : undefined) ??
    pending?.captured.modelSelection;
  if (!selection) throw new Error("Select a model before sending into a container.");
  const driver =
    live?.selectedProvider ??
    snapshot.providerDriver ??
    appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(session.environmentId)
      ?.providers.find((provider) => provider.instanceId === selection.instanceId)?.driver ??
    pending?.captured.driver;
  if (!driver) throw new Error("The selected provider is unavailable.");
  const content = live ?? draft;
  const hasContext =
    content &&
    [
      content.images,
      content.files,
      content.terminalContexts,
      content.previewAnnotations,
      content.reviewComments,
      content.threadContexts,
      content.environmentContexts,
      draft?.persistedAttachments ?? [],
    ].some((items) => items.length > 0);
  const special =
    isUsageLimitsCommand(text) ||
    parseSideChatCommand(text) ||
    parseStandaloneComposerSlashCommand(text) ||
    parseCodexFeedbackCommand(text);
  return {
    source: {
      environmentId: session.environmentId,
      projectId: session.projectId,
      checkoutPath:
        session.worktreePath ??
        snapshot.workspaceRoot ??
        session.container?.intent.source.checkoutPath ??
        "",
    },
    capture: {
      text,
      modelSelection: selection,
      driver,
      runtimeMode: draft?.runtimeMode ?? session.runtimeMode,
      interactionMode: live?.interactionMode ?? draft?.interactionMode ?? session.interactionMode,
      effort: live ? live.selectedPromptEffort : (pending?.captured.effort ?? null),
    },
    refusal: !snapshot.firstSendAllowed
      ? "Only unsent drafts can select a container."
      : live?.multipleModelSelections
        ? "First container Send does not support multiple models."
        : hasContext
          ? "Remove attachments and host context before first container Send. The source is unchanged."
          : special
            ? "This composer command is unavailable for the first container Send. Choose Local or send ordinary prompt text."
            : null,
  };
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}
export function useContainerSubmission(input: {
  draftId: DraftId | null;
  read: () => ContainerSourceSnapshot;
  hydrated: () => boolean;
  supported: () => boolean;
  clear: () => void;
  error: (message: string) => void;
}) {
  const navigate = useNavigate();
  const readSnapshot = useStableCallback(input.read);
  const currentDraftId = useStableCallback(() => input.draftId);
  const hydrated = useStableCallback(input.hydrated);
  const supported = useStableCallback(input.supported);
  const clear = useStableCallback(input.clear);
  const error = useStableCallback(input.error);
  const [visible, setVisible] = useState(false);
  const draftId = input.draftId;
  const state = useComposerDraftStore((store) =>
    draftId ? (store.getDraftSession(draftId)?.container ?? null) : null,
  );
  const navigateToThread = useStableCallback(
    async (
      destination: import("@t3tools/contracts").ContainerDestination,
      threadId: import("@t3tools/contracts").ThreadId,
    ) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(destination.guestEnvironmentId, threadId)),
      });
    },
  );
  const controllers = useRef(new Map<DraftId, ReturnType<typeof createContainerSubmission>>());
  const getController = (sourceId: DraftId) => {
    const existing = controllers.current.get(sourceId);
    if (existing) return existing;
    const readState = () =>
      useComposerDraftStore.getState().getDraftSession(sourceId)?.container ?? null;
    const controller = createContainerSubmission({
      read: () =>
        readContainerSource(
          sourceId,
          currentDraftId() === sourceId
            ? readSnapshot()
            : {
                editor: null,
                text: null,
                workspaceRoot: readState()?.intent.source.checkoutPath ?? null,
                firstSendAllowed: true,
                providerDriver: null,
              },
        ),
      hydrated,
      supported,
      clear: () => {
        if (currentDraftId() === sourceId) clear();
        else useComposerDraftStore.getState().clearComposerContent(sourceId);
      },
      error: (message) => {
        if (currentDraftId() === sourceId) error(message);
      },
      state: readState,
      write: (state) => useComposerDraftStore.getState().setContainerDraft(sourceId, state),
      persist: (state) => persistContainerDraft(sourceId, state),
      settings: async (intent) =>
        unwrap(
          await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.containers.settings,
            {
              environmentId: intent.source.environmentId,
              input: { projectId: intent.source.projectId },
            },
            { reportFailure: false },
          ),
        ),
      save: async (value, source) => {
        const current = readState();
        if (
          !current ||
          current.intent.source.environmentId !== source.environmentId ||
          current.intent.source.projectId !== source.projectId
        )
          throw new Error("Container selection was cleared.");
        return unwrap(
          await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.containers.configureProject,
            { environmentId: source.environmentId, input: value },
            { reportFailure: false },
          ),
        );
      },
      open: async (intent, revision) =>
        unwrap(
          await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.containers.open,
            {
              environmentId: intent.source.environmentId,
              input: {
                operationId: intent.operationId,
                projectId: intent.source.projectId,
                checkoutPath: intent.source.checkoutPath,
                selection: intent.choice,
                ...(revision ? { setupRevision: revision } : {}),
              },
            },
            { reportFailure: false },
          ),
        ),
      connect: async (destination) => {
        const config = unwrap(
          await runAtomCommand(appAtomRegistry, serverEnvironment.containers.connect, destination, {
            reportFailure: false,
          }),
        );
        return {
          providers: config.providers,
          supported:
            config.environment.environmentId === destination.guestEnvironmentId &&
            config.environment.capabilities.containerSubmissions === true,
        };
      },
      format: (capture, provider) =>
        formatOutgoingPrompt({
          provider: provider.driver,
          model: capture.modelSelection.model,
          models: provider.models,
          effort: capture.effort,
          text: capture.text.trim(),
        }),
      submit: async (destination, request) =>
        unwrap(
          await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.containers.submit,
            { environmentId: destination.guestEnvironmentId, input: request },
            { reportFailure: false },
          ),
        ),
      inspect: async (destination, request) =>
        unwrap(
          await runAtomCommand(
            appAtomRegistry,
            serverEnvironment.containers.inspect,
            { environmentId: destination.guestEnvironmentId, input: request },
            { reportFailure: false },
          ),
        ),
      navigate: navigateToThread,
    });
    controllers.current.set(sourceId, controller);
    return controller;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel local async waiting when the source route is replaced; this never retracts an issued guest request.
  useEffect(() => {
    return () => {
      if (!draftId) return;
      const state = useComposerDraftStore.getState().getDraftSession(draftId)?.container;
      if (!(state?.kind === "pending" && state.progress.kind === "accepted"))
        controllers.current.get(draftId)?.invalidate();
      controllers.current.delete(draftId);
    };
  }, [draftId]);
  const intercept: ReturnType<typeof createContainerSubmission>["intercept"] = async (request) => {
    if (draftId && useComposerDraftStore.getState().getDraftSession(draftId)?.container)
      setVisible(true);
    return draftId ? getController(draftId).intercept(request) : false;
  };
  const pending = state?.kind === "pending" ? state : null;
  const destination =
    pending && "destination" in pending.progress ? pending.progress.destination : null;
  const dialog = pending ? (
    <>
      <Button variant="link" size="xs" onClick={() => setVisible(true)}>
        Review container Send
      </Button>
      <Dialog
        open={visible}
        onOpenChange={(open) => {
          if (!open && draftId) getController(draftId).cancel();
          setVisible(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {pending.progress.kind === "setup" ? "Project environment" : "Container Send"}
            </DialogTitle>
            <DialogDescription>
              Your prompt stays in the source until the guest accepts it. Reload and reconnect never
              submit automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {pending.progress.kind === "setup" ? (
              <>
                <ContainerEnvironmentSetup
                  key={pending.progress.revision ?? "unconfirmed"}
                  title={pending.intent.source.checkoutPath}
                  initial={pending.progress.seed}
                  disabled={false}
                  onSave={async (value) => {
                    if (draftId) await getController(draftId).confirm(value);
                  }}
                  saveLabel="Save and continue"
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    if (draftId) void getController(draftId).reloadSetup();
                  }}
                >
                  Reload project environment
                </Button>
              </>
            ) : (
              <>
                <p role="status" className="text-sm">
                  {pending.progress.kind === "rejected"
                    ? "The guest rejected the original Send. You can explicitly start a corrected Send in the same runtime."
                    : pending.progress.kind === "accepted"
                      ? "The guest accepted the original prompt."
                      : pending.progress.kind === "request-issued"
                        ? "The original Send may already be accepted. Inspect or explicitly continue it."
                        : "Preparing the guest. Your source is unchanged."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (draftId) void getController(draftId).inspect();
                    }}
                  >
                    Inspect original Send
                  </Button>
                  <Button
                    onClick={() => {
                      if (draftId) void getController(draftId).continueOriginal();
                    }}
                  >
                    Continue original Send
                  </Button>
                  {pending.progress.kind === "rejected" ? (
                    <Button
                      onClick={() => {
                        if (draftId)
                          getController(draftId).correctRejected(
                            ContainerOperationId.make(newDraftId()),
                          );
                        setVisible(false);
                      }}
                    >
                      Use this runtime for a corrected Send
                    </Button>
                  ) : null}
                  {pending.progress.kind === "accepted" ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (draftId) void getController(draftId).openAccepted();
                      }}
                    >
                      Open guest thread
                    </Button>
                  ) : null}
                </div>
              </>
            )}
            {pending.error ? (
              <p role="alert" className="text-sm text-destructive">
                {pending.error}
              </p>
            ) : null}
            {destination ? (
              <Button
                variant="link"
                onClick={() =>
                  void navigate({
                    to: "/settings/providers",
                    search: { machine: destination.guestEnvironmentId },
                  })
                }
              >
                Guest provider settings
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                if (draftId) getController(draftId).cancel();
                setVisible(false);
              }}
            >
              Stop waiting
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  ) : null;
  return { intercept, dialog };
}
