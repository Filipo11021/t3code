import { BoxIcon } from "lucide-react";
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
import { useComposerMenuProps } from "../../components/chat/composerEventScope";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { serverEnvironment } from "../../state/server";
import { useStableCallback } from "../../hooks/useStableCallback";
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
    loaded?.key === `${input.environmentId}:${input.projectId}` ? loaded.value : null;
  const supported =
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
    async (environmentId: EnvironmentId, projectId: ProjectId, signal: AbortSignal) => {
      if (signal.aborted) return;
      const result = await runAtomCommand(
        registry,
        serverEnvironment.containers.settings,
        { environmentId, input: { projectId } },
        { reportFailure: false },
      );
      if (!signal.aborted)
        setLoaded({
          key: `${environmentId}:${projectId}`,
          value: result._tag === "Success" ? result.value : null,
        });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read managed choices from the selected host project without provisioning.
  useEffect(() => {
    if (!supported || !permission) return;
    const abort = new AbortController();
    void load(input.environmentId, input.projectId, abort.signal);
    return () => abort.abort();
  }, [load, input.environmentId, input.projectId, supported, permission]);
  const options = supported ? containerOptions(settings) : [];
  const selectedValue = state
    ? state.intent.choice.type === "fresh"
      ? "container:fresh"
      : `container:${state.intent.choice.workspaceId}`
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
  const menuItems = options.map((option) => (
    <MenuRadioItem key={option.value} value={option.value} disabled={!allowed} closeOnClick>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <BoxIcon className="size-3" />
        <span className="min-w-0 truncate">{option.label}</span>
      </span>
    </MenuRadioItem>
  ));
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
          {menuItems}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  ) : null;
  return {
    options,
    menuItems,
    standalone,
    onSelect,
    allowed,
    selectedValue,
    selectedLabel,
    issued,
  };
}
