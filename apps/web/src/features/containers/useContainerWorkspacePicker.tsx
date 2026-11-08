import { BoxesIcon, BoxIcon } from "lucide-react";
import { use, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ContainerOperationId,
  type ContainerSettings,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { newDraftId } from "../../lib/utils";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  composerFloatingLayerProps,
  useComposerMenuProps,
} from "../../components/chat/composerEventScope";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { serverEnvironment } from "../../state/server";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useClientSettings } from "../../hooks/useSettings";
import { containerOptions } from "./selection";
import { containerRequestIssued } from "./draftState";
export function useContainerWorkspacePicker(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly checkoutPath: string;
  readonly draftId: DraftId | undefined;
  readonly locked: boolean;
  readonly modelSelection: ModelSelection | undefined;
}) {
  const registry = use(RegistryContext);
  const floating = useComposerMenuProps();
  const config = useAtomValue(serverEnvironment.configValueAtom(input.environmentId));
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(input.environmentId));
  const runtimeSettingsKey = `${serverSettings?.containerRuntime ?? "docker"}:${
    serverSettings?.projectSettingsOverrides[input.projectId]?.containerRuntime ?? ""
  }`;
  const containersEnabled = useClientSettings((settings) => settings.containersEnabled);
  const permission = useAtomValue(
    serverEnvironment.containers.open.permissionAtom(input.environmentId),
  );
  const state = useComposerDraftStore((store) =>
    input.draftId ? (store.getDraftSession(input.draftId)?.container ?? null) : null,
  );
  const [loaded, setLoaded] = useState<{ key: string; value: ContainerSettings | null } | null>(
    null,
  );
  const settings =
    loaded?.key === `${input.environmentId}:${input.projectId}:${runtimeSettingsKey}`
      ? loaded.value
      : null;
  const supported =
    containersEnabled &&
    config?.environment.capabilities.containerWorkspaces === true &&
    Boolean(input.draftId) &&
    !input.locked;
  const issued = containerRequestIssued(state);
  const allowed =
    supported &&
    !issued &&
    permission &&
    config?.environment.capabilities.containerProjects === true;
  const load = useStableCallback(
    async (
      environmentId: EnvironmentId,
      projectId: ProjectId,
      runtimeKey: string,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) return;
      const result = await runAtomCommand(
        registry,
        serverEnvironment.containers.settings,
        { environmentId, input: { projectId } },
        { reportFailure: false },
      );
      if (!signal.aborted)
        setLoaded({
          key: `${environmentId}:${projectId}:${runtimeKey}`,
          value: result._tag === "Success" ? result.value : null,
        });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read managed choices from the selected host project without provisioning.
  useEffect(() => {
    if (!supported || !permission) return;
    const abort = new AbortController();
    void load(input.environmentId, input.projectId, runtimeSettingsKey, abort.signal);
    return () => abort.abort();
  }, [load, input.environmentId, input.projectId, supported, permission, runtimeSettingsKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Turning containers off drops a chosen workspace, while pending Sends stay recoverable.
  useEffect(() => {
    if (containersEnabled || !input.draftId || state?.kind !== "selected") return;
    useComposerDraftStore.getState().setContainerDraft(input.draftId, null);
  }, [containersEnabled, input.draftId, state]);
  const options = supported ? containerOptions(settings) : [];
  const liveState = containersEnabled ? state : null;
  const selectedValue = liveState
    ? liveState.intent.choice.type === "fresh"
      ? "container:fresh"
      : `container:${liveState.intent.choice.workspaceId}`
    : null;
  const selectedLabel =
    options.find((option) => option.value === selectedValue)?.label ??
    (selectedValue ? "Selected container" : null);
  const onSelect = (value: string) => {
    if (!allowed || !input.draftId) return;
    const workspace = settings?.workspaces.find(
      (workspace) => `container:${workspace.id}` === value && workspace.ownership === "managed",
    );
    if (value !== "container:fresh" && !workspace) return;
    useComposerDraftStore.getState().setContainerDraft(input.draftId, {
      kind: "selected",
      intent: {
        operationId: ContainerOperationId.make(newDraftId()),
        source: {
          environmentId: input.environmentId,
          projectId: input.projectId,
          checkoutPath: input.checkoutPath,
        },
        choice: workspace ? { type: "existing", workspaceId: workspace.id } : { type: "fresh" },
      },
    });
  };
  const fresh = options[0];
  const existing = options.slice(1);
  const freshItem =
    supported && fresh ? (
      <MenuRadioItem value={fresh.value} disabled={!allowed} closeOnClick>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <BoxIcon className="size-3" />
          <span className="min-w-0 truncate">{fresh.label}</span>
        </span>
      </MenuRadioItem>
    ) : null;
  const existingItem =
    supported && existing.length > 0 ? (
      <MenuSub>
        <MenuSubTrigger disabled={!allowed}>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <BoxesIcon className="size-3" />
            <span className="min-w-0 truncate">
              {existing.length === 1 ? "Existing container" : "Existing containers"}
            </span>
          </span>
        </MenuSubTrigger>
        <MenuSubPopup {...composerFloatingLayerProps}>
          <MenuRadioGroup value={selectedValue ?? ""} onValueChange={onSelect}>
            {existing.map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                disabled={!allowed}
                closeOnClick
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <BoxIcon className="size-3" />
                  <span className="min-w-0 truncate">{option.label}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
    ) : null;
  const standalone = supported ? (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="xs" />} data-composer-context-control>
        {selectedLabel ?? "Workspace"}
      </MenuTrigger>
      <MenuPopup {...floating}>
        <MenuRadioGroup
          value={selectedValue ?? "local"}
          onValueChange={(value) => {
            if (value === "local" && input.draftId)
              useComposerDraftStore
                .getState()
                .setDraftThreadContext(input.draftId, { envMode: "local" });
            else onSelect(value);
          }}
        >
          <MenuRadioItem value="local" disabled={issued} closeOnClick>
            Local
          </MenuRadioItem>
          {freshItem}
        </MenuRadioGroup>
        {existingItem}
      </MenuPopup>
    </Menu>
  ) : null;
  return {
    freshItem,
    existingItem,
    standalone,
    onSelect,
    selectedValue,
    selectedLabel,
    issued,
  };
}
