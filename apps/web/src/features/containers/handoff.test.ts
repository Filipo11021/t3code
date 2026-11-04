import { expect, it, vi } from "vite-plus/test";
import {
  ContainerOperationId,
  ContainerWorkspaceId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ContainerDestination,
  type ServerProvider,
} from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { handoffContainerDraft } from "./handoff";

function setup() {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState());
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("source-draft");
  store.setProjectDraftThreadId(
    { environmentId: EnvironmentId.make("host"), projectId: ProjectId.make("host-project") },
    draftId,
    {
      threadId: ThreadId.make("source-thread"),
      runtimeMode: "full-access",
      interactionMode: "plan",
      envMode: "local",
    },
  );
  store.setPrompt(draftId, "Do not lose this draft");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("host-codex"),
    model: "gpt-test",
    options: [{ id: "reasoning", value: "high" }],
  };
  store.setModelSelection(draftId, modelSelection, { explicit: true });
  const provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-04T00:00:00.000Z",
    models: [{ slug: "gpt-test", name: "Test model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  const guest = {
    ...provider,
    instanceId: ProviderInstanceId.make("guest-codex"),
    installed: false,
    auth: { status: "unauthenticated" as const },
  };
  const operationId = ContainerOperationId.make("transfer-one");
  const destination: ContainerDestination = {
    hostEnvironmentId: EnvironmentId.make("host"),
    workspaceId: ContainerWorkspaceId.make("workspace"),
    guestEnvironmentId: EnvironmentId.make("guest"),
    guestProjectId: ProjectId.make("guest-project"),
    guestCheckoutPath: "/repo",
    label: "Ubuntu",
  };
  const input = {
    draftId,
    operationId,
    modelSelection,
    providers: [provider],
    signal: new AbortController().signal,
    prepare: vi.fn(async () => ({ destination, providers: [guest] })),
    navigate: vi.fn(async (_draftId: DraftId): Promise<void> => undefined),
  };
  return { store, input, guest, destination };
}

it("moves an unsent draft, modes, reasoning and semantic model into the guest before removing the source", async () => {
  const f = setup();
  f.input.navigate.mockImplementation(async (draftId: DraftId) => {
    expect(f.store.getDraftSession(f.input.draftId)).not.toBeNull();
    expect(f.store.getDraftSession(draftId)?.environmentId).toBe(f.destination.guestEnvironmentId);
  });
  await handoffContainerDraft(f.input);
  const id = DraftId.make(f.input.operationId);
  const store = useComposerDraftStore.getState();
  expect(store.getComposerDraft(id)?.prompt).toBe("Do not lose this draft");
  expect(store.getComposerDraft(id)?.modelSelectionByProvider[f.guest.instanceId]).toEqual({
    ...f.input.modelSelection,
    instanceId: f.guest.instanceId,
  });
  expect(store.getDraftSession(id)).toMatchObject({
    runtimeMode: "full-access",
    interactionMode: "plan",
    envMode: "local",
  });
  expect(store.getDraftSession(f.input.draftId)).toBeNull();
});

it.each(["setup", "provider", "source-edit", "navigation", "retry-model"])(
  "preserves the source after %s failure without launching a host turn",
  async (failure) => {
    const f = setup();
    if (failure === "setup") f.input.prepare.mockRejectedValue(new Error("engine unavailable"));
    if (failure === "provider")
      f.input.prepare.mockResolvedValue({ destination: f.destination, providers: [] });
    if (failure === "source-edit")
      f.input.prepare.mockImplementation(async () => {
        useComposerDraftStore.getState().setPrompt(f.input.draftId, "Edited during provisioning");
        return { destination: f.destination, providers: [f.guest] };
      });
    if (failure === "navigation" || failure === "retry-model")
      f.input.navigate.mockRejectedValue(new Error("route failed"));
    if (failure === "retry-model") {
      await expect(handoffContainerDraft(f.input)).rejects.toThrow("route failed");
      f.input.navigate.mockResolvedValue(undefined);
      f.input.modelSelection = {
        ...f.input.modelSelection,
        options: [{ id: "reasoning", value: "low" }],
      };
      useComposerDraftStore.getState().setModelSelection(f.input.draftId, f.input.modelSelection, {
        explicit: true,
        replaceOptions: true,
      });
    }
    await expect(handoffContainerDraft(f.input)).rejects.toThrow();
    expect(useComposerDraftStore.getState().getDraftSession(f.input.draftId)).not.toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(f.input.draftId)?.prompt).toBe(
      failure === "source-edit" ? "Edited during provisioning" : "Do not lose this draft",
    );
  },
);

it("refuses host context before provisioning and leaves the entire draft intact", async () => {
  const f = setup();
  f.store.setTerminalContexts(f.input.draftId, [
    {
      id: "terminal-context",
      threadId: ThreadId.make("source-thread"),
      terminalId: "terminal",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 2,
      text: "host output",
      createdAt: "2026-11-04T00:00:00.000Z",
    },
  ]);
  await expect(handoffContainerDraft(f.input)).rejects.toThrow(
    "Remove attachments and host context",
  );
  expect(f.input.prepare).not.toHaveBeenCalled();
  expect(
    useComposerDraftStore.getState().getComposerDraft(f.input.draftId)?.terminalContexts,
  ).toHaveLength(1);
});
