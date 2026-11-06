import { expect, it } from "vite-plus/test";
import {
  ContainerConfigurationRevision,
  ContainerOperationId,
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ContainerSubmissionInput,
  type ContainerSubmissionStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  containerSendEntry,
  createContainerSubmission,
  type ContainerLiveSource,
} from "./submission";
import type { ContainerDraftState } from "./draftState";

const revision = ContainerConfigurationRevision.make("saved-revision");
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve() };
}
function fixture(confirmed = true) {
  const source = {
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("source"),
    checkoutPath: "/source/worktree",
  };
  const intent = {
    operationId: ContainerOperationId.make("one-send"),
    source,
    choice: { type: "fresh" as const },
  };
  let state: ContainerDraftState | null = { kind: "selected", intent };
  let live: ContainerLiveSource = {
    source,
    capture: {
      text: "Live editor prompt",
      modelSelection: {
        instanceId: ProviderInstanceId.make("host-codex"),
        model: "test-model",
        options: [{ id: "reasoning", value: "high" }],
      },
      driver: ProviderDriverKind.make("codex"),
      runtimeMode: "full-access",
      interactionMode: "plan",
      effort: null,
    },
    refusal: null,
  };
  const destination = {
    hostEnvironmentId: source.environmentId,
    workspaceId: ContainerWorkspaceId.make("one-send"),
    guestEnvironmentId: EnvironmentId.make("guest"),
    guestProjectId: ProjectId.make("guest-project"),
    guestCheckoutPath: "/recorded-checkout",
    label: "Test container",
  };
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("guest-codex"),
    driver: live.capture.driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-05T00:00:00.000Z",
    models: [{ slug: "test-model", name: "Test", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
  const submitted: Array<{ environmentId: EnvironmentId; request: ContainerSubmissionInput }> = [];
  const persisted: ContainerDraftState[] = [];
  const opened: Array<{ operationId: string; revision: string | null }> = [];
  const openedSignal = deferred();
  const errors: string[] = [];
  let clearCount = 0;
  let navigations = 0;
  let formatted = 0;
  let inspections = 0;
  let providers = [provider];
  let openWait = Promise.resolve();
  let connectWait = Promise.resolve();
  let persistFailure = false;
  let navigationFailure = false;
  let responseLost = false;
  let saved = confirmed;
  let settingsFailure = false;
  let inspected: ContainerSubmissionStatus = { kind: "reserved" };
  const accepted: ContainerSubmissionStatus = {
    kind: "accepted",
    threadId: ThreadId.make("guest-thread"),
    runId: RunId.make("guest-run"),
    sequence: 9,
    preparation: "released",
  };
  const controller = createContainerSubmission({
    state: () => state,
    read: () => live,
    hydrated: () => true,
    supported: () => true,
    write: (next) => {
      state = next;
    },
    persist: async (next) => {
      if (persistFailure) throw new Error("storage failed");
      persisted.push(structuredClone(next));
      state = next;
    },
    settings: async () => {
      if (settingsFailure) throw new Error("settings failed");
      return {
        config: DEFAULT_CONTAINER_CONFIG,
        available: true,
        workspaces: [],
        project: {
          projectId: source.projectId,
          setup: saved ? { revision, value: DEFAULT_CONTAINER_CONFIG } : null,
          cleanup: null,
        },
      };
    },
    save: async (input) => {
      if (input.expectedRevision !== (saved ? revision : null)) throw new Error("setup conflict");
      saved = true;
      return revision;
    },
    open: async (intent, revision) => {
      opened.push({ operationId: intent.operationId, revision });
      openedSignal.resolve();
      await openWait;
      return destination;
    },
    connect: async () => {
      await connectWait;
      return { providers, supported: true };
    },
    format: (capture) => {
      formatted++;
      return `formatted ${capture.text}`;
    },
    submit: async (target, request) => {
      submitted.push({ environmentId: target.guestEnvironmentId, request });
      if (responseLost) throw new Error("response lost");
      return accepted;
    },
    inspect: async () => {
      inspections++;
      return inspected;
    },
    navigate: async (target, threadId) => {
      expect(target.guestEnvironmentId).toBe(destination.guestEnvironmentId);
      expect(threadId).toBe(ThreadId.make("guest-thread"));
      navigations++;
      if (navigationFailure) throw new Error("navigation failed");
    },
    clear: () => {
      clearCount++;
      live = { ...live, capture: { ...live.capture, text: "" } };
    },
    error: (message) => {
      errors.push(message);
    },
  });
  const send = () =>
    controller.intercept({
      dispatchMode: "auto",
      submissionIntent: "foreground",
      directAnnotation: false,
    });
  return {
    controller,
    send,
    destination,
    intent,
    submitted,
    persisted,
    opened,
    errors,
    openedSignal: openedSignal.promise,
    state: () => state,
    setState: (next: ContainerDraftState | null) => {
      state = next;
    },
    live: () => live,
    edit: (patch: Partial<ContainerLiveSource>) => {
      live = { ...live, ...patch };
    },
    openWait: (wait: Promise<void>) => {
      openWait = wait;
    },
    connectWait: (wait: Promise<void>) => {
      connectWait = wait;
    },
    providers: (next: ServerProvider[]) => {
      providers = next;
    },
    provider,
    persistFailure: (value: boolean) => {
      persistFailure = value;
    },
    navigationFailure: (value: boolean) => {
      navigationFailure = value;
    },
    responseLost: (value: boolean) => {
      responseLost = value;
    },
    inspected: (value: ContainerSubmissionStatus) => {
      inspected = value;
    },
    confirmed: (value: boolean) => {
      saved = value;
    },
    settingsFailure: (value: boolean) => {
      settingsFailure = value;
    },
    clearCount: () => clearCount,
    navigations: () => navigations,
    formatted: () => formatted,
    inspections: () => inspections,
  };
}

it("defers first setup and continues the preserved live source only in the guest with the exact saved revision", async () => {
  const f = fixture(false);
  expect(await f.send()).toBe(true);
  expect(f.opened).toEqual([]);
  expect(f.state()?.kind).toBe("pending");
  await f.controller.confirm(DEFAULT_CONTAINER_CONFIG);
  expect(f.opened).toEqual([{ operationId: f.intent.operationId, revision }]);
  expect(f.submitted).toEqual([
    {
      environmentId: f.destination.guestEnvironmentId,
      request: {
        operationId: f.intent.operationId,
        message: {
          projectId: f.destination.guestProjectId,
          text: "formatted Live editor prompt",
          modelSelection: {
            instanceId: f.provider.instanceId,
            model: "test-model",
            options: [{ id: "reasoning", value: "high" }],
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
        },
      },
    },
  ]);
  expect(f.persisted[0]?.kind === "pending" && f.persisted[0].progress.kind).toBe("request-issued");
  expect(f.clearCount()).toBe(1);
  expect(f.navigations()).toBe(1);
});

it("preserves source on unsupported dispatch, annotations, host context, model mode and stale source before provisioning", async () => {
  for (const refusal of [
    "attachments",
    "host context",
    "multiple models",
    "/limits",
    "/side",
    "feedback",
    "standalone mode",
  ]) {
    const f = fixture();
    f.edit({ refusal });
    expect(await f.send()).toBe(true);
    expect(f.opened).toEqual([]);
    expect(f.clearCount()).toBe(0);
  }
  const f = fixture();
  expect(
    await f.controller.intercept({
      dispatchMode: "queue",
      submissionIntent: "foreground",
      directAnnotation: false,
    }),
  ).toBe(true);
  expect(
    await f.controller.intercept({
      dispatchMode: "auto",
      submissionIntent: "foreground",
      directAnnotation: true,
    }),
  ).toBe(true);
  f.edit({ source: { ...f.intent.source, projectId: ProjectId.make("different-project") } });
  await f.send();
  expect(f.opened).toEqual([]);
  expect(f.submitted).toEqual([]);
});

it("gates the actual Send entry before any host command, upload, optimistic write or clearing, including /limits", async () => {
  for (const prompt of ["/limits", "/side hello", "/feedback useful", "/plan", "ordinary prompt"]) {
    const f = fixture();
    f.edit({
      capture: { ...f.live().capture, text: prompt },
      refusal: "Unsupported first-container command or context",
    });
    const source = { prompt, uploads: [] as string[], events: [] as string[] };
    let prevented = false;
    const onSend = containerSendEntry({
      intercept: async (request) => {
        expect(prevented).toBe(true);
        return f.controller.intercept(request);
      },
      onHostSend: async () => {
        source.events.push("host-command", "optimistic-message", "host-launch");
        source.uploads.push("host-upload");
        source.prompt = "";
      },
    });
    await onSend({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(source).toEqual({ prompt, uploads: [], events: [] });
    expect(f.opened).toEqual([]);
  }
  let hostSent = false;
  const failed = containerSendEntry({
    intercept: async () => {
      throw new Error("inspection failed");
    },
    onHostSend: async () => {
      hostSent = true;
    },
  });
  await expect(failed()).rejects.toThrow("inspection failed");
  expect(hostSent).toBe(false);
});

it("fences cancellation and source replacement after open starts, and preserves source edits during setup", async () => {
  for (const ending of ["cancel", "replace", "edit"] as const) {
    const f = fixture();
    const release = deferred();
    f.openWait(release.promise);
    const sending = f.send();
    await f.openedSignal;
    if (ending === "cancel") f.controller.cancel();
    else if (ending === "replace") f.setState(null);
    else f.edit({ capture: { ...f.live().capture, text: "newer edit" } });
    release.resolve();
    await sending;
    expect(f.submitted).toEqual([]);
    expect(f.clearCount()).toBe(0);
  }
});

it("blocks duplicate Send and persistence failure before guest issuance", async () => {
  const f = fixture();
  const release = deferred();
  f.openWait(release.promise);
  const first = f.send();
  await f.send();
  release.resolve();
  await first;
  expect(f.submitted).toHaveLength(1);
  const failed = fixture();
  failed.persistFailure(true);
  await failed.send();
  expect(failed.submitted).toEqual([]);
  expect(failed.clearCount()).toBe(0);
  expect(failed.errors.at(-1)).toBe("storage failed");
});

it("compares live model options semantically rather than rejecting an equal reordered source", async () => {
  const f = fixture();
  const options = [
    { id: "reasoning", value: "high" },
    { id: "speed", value: "fast" },
  ];
  f.edit({
    capture: {
      ...f.live().capture,
      modelSelection: { ...f.live().capture.modelSelection, options },
    },
  });
  const release = deferred();
  f.openWait(release.promise);
  const sending = f.send();
  await f.openedSignal;
  f.edit({
    capture: {
      ...f.live().capture,
      modelSelection: { ...f.live().capture.modelSelection, options: [...options].reverse() },
    },
  });
  release.resolve();
  await sending;
  expect(f.submitted).toHaveLength(1);
  expect(f.clearCount()).toBe(1);
});

it("keeps an open setup editor when Send is pressed again", async () => {
  const f = fixture(false);
  await f.send();
  const setup = f.state();
  expect(setup?.kind === "pending" && setup.progress.kind).toBe("setup");
  await f.send();
  expect(f.state()).toBe(setup);
  expect(f.opened).toEqual([]);
});

it("re-reads confirmed setup when a settings failure left an opening state without a revision", async () => {
  const f = fixture();
  f.settingsFailure(true);
  await f.send();
  const opening = f.state();
  expect(opening?.kind === "pending" && opening.progress.kind).toBe("opening");
  expect(
    opening?.kind === "pending" && opening.progress.kind === "opening"
      ? opening.progress.revision
      : "missing",
  ).toBeNull();
  expect(f.opened).toEqual([]);
  f.settingsFailure(false);
  await f.controller.continueOriginal();
  expect(f.opened).toEqual([{ operationId: f.intent.operationId, revision }]);
  expect(f.submitted).toHaveLength(1);
});

it("reloads uncertain requests as inspect-only and explicitly retries the frozen payload without remapping or formatting", async () => {
  const f = fixture();
  f.responseLost(true);
  await f.send();
  expect(f.submitted).toHaveLength(1);
  expect(f.clearCount()).toBe(0);
  const frozen = structuredClone(f.submitted[0]);
  const recovered = fixture();
  recovered.setState(structuredClone(f.state()));
  expect(recovered.submitted).toEqual([]);
  expect(recovered.inspections()).toBe(0);
  recovered.edit({
    capture: {
      ...recovered.live().capture,
      text: "newer edit",
      modelSelection: { instanceId: ProviderInstanceId.make("different"), model: "different" },
    },
  });
  await recovered.send();
  expect(recovered.inspections()).toBe(1);
  expect(recovered.submitted).toHaveLength(0);
  await recovered.controller.continueOriginal();
  expect(recovered.submitted[0]).toEqual(frozen);
  expect(recovered.formatted()).toBe(0);
  expect(recovered.clearCount()).toBe(0);
});

it("keeps confirmed setup after source edits and requires explicit conflict reload; existing choices need no confirmation", async () => {
  const f = fixture(false);
  await f.send();
  f.edit({ capture: { ...f.live().capture, text: "edited during setup" } });
  await f.controller.confirm(DEFAULT_CONTAINER_CONFIG);
  expect(f.opened).toEqual([]);
  expect(f.submitted).toEqual([]);
  await f.send();
  expect(f.submitted[0]?.request.message.text).toBe("formatted edited during setup");
  const conflict = fixture(false);
  await conflict.send();
  conflict.confirmed(true);
  await conflict.controller.confirm(DEFAULT_CONTAINER_CONFIG);
  expect(conflict.errors.at(-1)).toBe("setup conflict");
  expect(conflict.opened).toEqual([]);
  await conflict.controller.reloadSetup();
  await conflict.controller.confirm(DEFAULT_CONTAINER_CONFIG);
  expect(conflict.submitted).toHaveLength(1);
  const existing = fixture(false);
  existing.setState({
    kind: "selected",
    intent: {
      ...existing.intent,
      choice: { type: "existing", workspaceId: existing.destination.workspaceId },
    },
  });
  await existing.send();
  expect(existing.opened[0]?.revision).toBeNull();
  expect(existing.submitted).toHaveLength(1);
});

it("retains provider setup recovery and retries only navigation after acceptance", async () => {
  const f = fixture();
  f.providers([{ ...f.provider, installed: false }]);
  await f.send();
  expect(f.submitted).toEqual([]);
  expect(f.clearCount()).toBe(0);
  f.providers([f.provider]);
  f.navigationFailure(true);
  await f.controller.continueOriginal();
  expect(f.submitted).toHaveLength(1);
  expect(f.clearCount()).toBe(0);
  f.navigationFailure(false);
  await f.send();
  expect(f.submitted).toHaveLength(1);
  expect(f.clearCount()).toBe(1);
  expect(f.navigations()).toBe(2);
});

it("preserves background intent and cancellation after issuance without retracting the turn", async () => {
  const f = fixture();
  await f.controller.intercept({
    dispatchMode: "auto",
    submissionIntent: "background",
    directAnnotation: false,
  });
  expect(f.navigations()).toBe(0);
  expect(f.clearCount()).toBe(1);
  expect(f.state()?.kind).toBe("pending");
  f.controller.cancel();
  expect(f.state()?.kind).toBe("pending");
  await f.controller.openAccepted();
  expect(f.navigations()).toBe(1);
  expect(f.submitted).toHaveLength(1);
});

it("allows a corrected new operation only after an attributable durable rejection and reuses its runtime", async () => {
  const f = fixture();
  f.responseLost(true);
  await f.send();
  f.controller.correctRejected(ContainerOperationId.make("not-proven"));
  expect(f.state()?.intent.operationId).toBe(f.intent.operationId);
  f.inspected({ kind: "rejected", reason: "The original guest message was rejected." });
  await f.controller.inspect();
  expect(f.clearCount()).toBe(0);
  f.controller.correctRejected(ContainerOperationId.make("corrected-send"));
  expect(f.state()).toMatchObject({
    kind: "selected",
    intent: {
      operationId: "corrected-send",
      choice: { type: "existing", workspaceId: f.destination.workspaceId },
    },
  });
  f.responseLost(false);
  await f.send();
  expect(f.submitted[1]?.request.operationId).toBe("corrected-send");
});
