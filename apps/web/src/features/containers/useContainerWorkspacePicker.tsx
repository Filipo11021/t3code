import { use, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ContainerOperationId,
  ContainerSelection,
  type ContainerDestination,
  type ContainerSettings,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import type { DraftId } from "../../composerDraftStore";
import { newDraftId } from "../../lib/utils";
import * as Schema from "effect/Schema";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useComposerMenuProps } from "../../components/chat/composerEventScope";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { serverEnvironment } from "../../state/server";
import { handoffContainerDraft } from "./handoff";

const Pending = Schema.Struct({ operationId: ContainerOperationId, selection: ContainerSelection });
const decodePending = Schema.decodeSync(Schema.fromJsonString(Pending));
const encodePending = Schema.encodeSync(Schema.fromJsonString(Pending));
const storageKey = (draftId: DraftId) => `t3code:container-transfer:${draftId}`;
function readPending(draftId: DraftId | undefined) {
  try {
    const text = draftId ? localStorage.getItem(storageKey(draftId)) : null;
    return text === null ? null : decodePending(text);
  } catch {
    return null;
  }
}
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Container setup failed. Your source draft is unchanged.";

export type ContainerPickerOption = {
  readonly value: "container-fresh" | "container-existing";
  readonly label: string;
};

export function useContainerWorkspacePicker(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly checkoutPath: string;
  readonly draftId: DraftId | undefined;
  readonly locked: boolean;
  readonly modelSelection: ModelSelection | undefined;
}) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const floating = useComposerMenuProps();
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const allowed = useAtomValue(
    serverEnvironment.containers.open.permissionAtom(input.environmentId),
  );
  const [view, setView] = useState<"fresh" | "existing" | null>(null);
  const [pending, setPending] = useState(() => readPending(input.draftId));
  const [settings, setSettings] = useState<ContainerSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<ContainerDestination | null>(null);
  const active = useRef<AbortController | null>(null);
  const supported =
    config?.environment.capabilities.containerWorkspaces === true &&
    Boolean(input.draftId) &&
    !input.locked;
  const options: ReadonlyArray<ContainerPickerOption> = supported
    ? [
        {
          value: "container-fresh",
          label: pending ? "Resume container setup" : "Fresh Ubuntu container",
        },
        { value: "container-existing", label: "Existing container…" },
      ]
    : [];
  const open = async (value: string) => {
    if (!supported || !allowed) return;
    setView(value === "container-existing" ? "existing" : "fresh");
    setError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.containers.settings,
      {
        environmentId: input.environmentId,
        input: { projectId: input.projectId, checkoutPath: input.checkoutPath },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") setSettings(result.value);
    else setError(errorMessage(squashAtomCommandFailure(result)));
  };
  const perform = async (selection: ContainerSelection, resume = false) => {
    if (!input.draftId || !input.modelSelection || busy || !allowed) return;
    const operation =
      resume && pending
        ? pending
        : { operationId: ContainerOperationId.make(newDraftId()), selection };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(storageKey(input.draftId), encodePending(operation));
      setPending(operation);
      await handoffContainerDraft({
        draftId: input.draftId,
        operationId: operation.operationId,
        modelSelection: input.modelSelection,
        providers: config?.providers ?? [],
        signal: controller.signal,
        prepare: async () => {
          const opened = await runAtomCommand(
            registry,
            serverEnvironment.containers.open,
            {
              environmentId: input.environmentId,
              input: {
                operationId: operation.operationId,
                projectId: input.projectId,
                checkoutPath: input.checkoutPath,
                selection: operation.selection,
              },
            },
            { reportFailure: false },
          );
          if (opened._tag !== "Success") throw squashAtomCommandFailure(opened);
          setDestination(opened.value);
          controller.signal.throwIfAborted();
          const connected = await runAtomCommand(
            registry,
            serverEnvironment.containers.connect,
            opened.value,
            { reportFailure: false },
          );
          if (connected._tag !== "Success") throw squashAtomCommandFailure(connected);
          return { destination: opened.value, providers: connected.value.providers };
        },
        navigate: (draftId) => navigate({ to: "/draft/$draftId", params: { draftId } }),
      });
      localStorage.removeItem(storageKey(input.draftId));
      setPending(null);
      setView(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    }
    setBusy(false);
    active.current = null;
  };
  const menuItems = options.map((option) => (
    <MenuItem key={option.value} disabled={!allowed} onClick={() => void open(option.value)}>
      {option.label}
    </MenuItem>
  ));
  const standalone = supported ? (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="xs" />} data-composer-context-control>
        Container
      </MenuTrigger>
      <MenuPopup {...floating}>{menuItems}</MenuPopup>
    </Menu>
  ) : null;
  const dialog = (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) {
          active.current?.abort();
          setView(null);
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {view === "existing"
              ? "Existing container"
              : pending
                ? "Resume container setup"
                : "Fresh Ubuntu container"}
          </DialogTitle>
          <DialogDescription>
            Source files and Git metadata are shared with the host. Processes, provider logins,
            home, and history belong to the guest. Full host maintenance access is required.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-4 text-sm">
          <p>
            Move this unsent draft before sending. Remove attachments and host context first, then
            attach files in the guest. Provider setup is separate.
          </p>
          {busy ? (
            <p role="status">
              Preparing and connecting the container. The source draft remains safe.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {view === "existing" ? (
            <div className="flex flex-col gap-2">
              {settings?.workspaces.length === 0 ? (
                <p>
                  No compatible containers for this checkout. Create a fresh container first.
                  Arbitrary external containers are not modified.
                </p>
              ) : (
                settings?.workspaces.map((workspace) => (
                  <Button
                    key={workspace.id}
                    variant="outline"
                    disabled={busy || workspace.ownership !== "managed"}
                    onClick={() => void perform({ type: "existing", workspaceId: workspace.id })}
                  >
                    {workspace.id.slice(0, 8)} · {workspace.status.type}
                  </Button>
                ))
              )}
            </div>
          ) : null}
          {destination && error ? (
            <Button
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/settings/providers",
                  search: { machine: destination.guestEnvironmentId },
                })
              }
            >
              Open guest provider settings
            </Button>
          ) : null}
          <Button
            variant="link"
            onClick={() =>
              void navigate({
                to: "/settings/containers",
                search: { machine: input.environmentId },
              })
            }
          >
            Container settings
          </Button>
        </div>
        <DialogFooter>
          {view === "fresh" ? (
            <>
              {pending ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (input.draftId) localStorage.removeItem(storageKey(input.draftId));
                    setPending(null);
                  }}
                >
                  Use a new container instead
                </Button>
              ) : null}
              <Button
                disabled={busy || !allowed || !input.modelSelection}
                onClick={() => void perform({ type: "fresh" }, true)}
              >
                {busy
                  ? "Preparing…"
                  : pending
                    ? "Retry and open"
                    : `Create ${settings?.config.image ?? "ubuntu:26.04"} and open`}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
  return {
    options,
    menuItems,
    standalone,
    dialog,
    onSelect: (value: string) => {
      void open(value);
    },
    allowed,
  };
}
