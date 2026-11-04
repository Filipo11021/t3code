import {
  ThreadId,
  type ContainerDestination,
  type ContainerOperationId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  DraftId,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { modelSelectionsEqual } from "@t3tools/shared/model";

export async function handoffContainerDraft(input: {
  readonly draftId: DraftId;
  readonly operationId: ContainerOperationId;
  readonly modelSelection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly prepare: () => Promise<{
    readonly destination: ContainerDestination;
    readonly providers: ReadonlyArray<ServerProvider>;
  }>;
  readonly navigate: (draftId: DraftId) => Promise<void>;
  readonly signal: AbortSignal;
}) {
  const store = useComposerDraftStore.getState();
  const source = store.getComposerDraft(input.draftId);
  const session = store.getDraftSession(input.draftId);
  if (!session) throw new Error("Only an unsent draft can move into a container.");
  if (
    source &&
    [
      source.images,
      source.files,
      source.persistedAttachments,
      source.terminalContexts,
      source.previewAnnotations,
      source.reviewComments,
      source.threadContexts,
      source.environmentContexts,
    ].some((items) => items.length > 0)
  ) {
    throw new Error(
      "Remove attachments and host context before moving this draft. You can attach files again in the container. Your draft is unchanged.",
    );
  }
  const provider = input.providers.find(
    (provider) => provider.instanceId === input.modelSelection.instanceId,
  );
  if (!provider) throw new Error("Select a provider before opening a container.");
  const prepared = await input.prepare();
  input.signal.throwIfAborted();
  const guestProvider = prepared.providers.find(
    (candidate) => candidate.driver === provider.driver && candidate.enabled,
  );
  if (!guestProvider)
    throw new Error(
      `Set up ${provider.displayName ?? provider.driver} in the container's provider settings, then retry. Your host draft is unchanged.`,
    );
  if (
    guestProvider.installed &&
    guestProvider.models.length > 0 &&
    !guestProvider.models.some(
      (model) =>
        model.slug === input.modelSelection.model ||
        model.aliases?.includes(input.modelSelection.model),
    )
  ) {
    throw new Error(
      "The selected model is not available in the container. Your draft and model selection are unchanged.",
    );
  }
  const current = useComposerDraftStore.getState();
  if (
    current.getComposerDraft(input.draftId) !== source ||
    current.getDraftSession(input.draftId) !== session
  ) {
    throw new Error(
      "The source draft changed during setup. Retry to carry the latest text and settings into this container.",
    );
  }
  const destinationId = DraftId.make(input.operationId);
  const existing = current.getComposerDraft(destinationId);
  const existingSession = current.getDraftSession(destinationId);
  const selection = { ...input.modelSelection, instanceId: guestProvider.instanceId };
  const existingSelection = existing?.modelSelectionByProvider[guestProvider.instanceId];
  if (
    (composerDraftHasUserContent(existing) && existing?.prompt !== (source?.prompt ?? "")) ||
    (existingSession &&
      (existingSession.environmentId !== prepared.destination.guestEnvironmentId ||
        existingSession.projectId !== prepared.destination.guestProjectId ||
        existingSession.runtimeMode !== (source?.runtimeMode ?? session.runtimeMode) ||
        existingSession.interactionMode !== (source?.interactionMode ?? session.interactionMode) ||
        !existingSelection ||
        !modelSelectionsEqual(existingSelection, selection)))
  )
    throw new Error(
      "The destination draft differs from the source. Both drafts are preserved; open it separately or use a new container.",
    );
  if (!existingSession) {
    current.setLogicalProjectDraftThreadId(
      `container-transfer:${input.draftId}`,
      {
        environmentId: prepared.destination.guestEnvironmentId,
        projectId: prepared.destination.guestProjectId,
      },
      destinationId,
      {
        threadId: ThreadId.make(input.operationId),
        envMode: "local",
        branch: null,
        worktreePath: null,
        runtimeMode: source?.runtimeMode ?? session.runtimeMode,
        interactionMode: source?.interactionMode ?? session.interactionMode,
        environmentSelection: "manual",
        startFromOrigin: false,
      },
    );
    current.setPrompt(destinationId, source?.prompt ?? "");
    current.setModelSelection(destinationId, selection, { explicit: true, replaceOptions: true });
  }
  input.signal.throwIfAborted();
  await input.navigate(destinationId);
  const after = useComposerDraftStore.getState();
  if (
    after.getComposerDraft(input.draftId) === source &&
    after.getDraftSession(input.draftId) === session
  )
    after.clearDraftThread(input.draftId);
  return prepared.destination;
}
