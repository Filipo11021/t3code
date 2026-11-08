import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { BoxIcon, FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  containerFreshItem?: ReactNode;
  containerExistingItem?: ReactNode;
  onContainerSelect?: (value: string) => void;
  containerValue?: string | null;
  containerLabel?: string | null;
  containerPending?: boolean;
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
  containerFreshItem,
  containerExistingItem,
  onContainerSelect,
  containerValue = null,
  containerLabel = null,
  containerPending = false,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const workspaceLabel =
    containerLabel ??
    (effectiveEnvMode === "worktree"
      ? resolveEnvModeLabel("worktree")
      : resolveCurrentWorkspaceLabel(activeWorktreePath));
  const workspaceIcon = containerValue ? (
    <BoxIcon className="size-3" />
  ) : effectiveEnvMode === "worktree" ? (
    <FolderGit2Icon className="size-3" />
  ) : activeWorktreePath ? (
    <FolderGitIcon className="size-3" />
  ) : (
    <FolderIcon className="size-3" />
  );

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel>
          {forceNewWorktree
            ? resolveEnvModeLabel("worktree")
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </ComposerContextLabel>
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size="xs" />}
        className="min-w-0 shrink"
        aria-label="Workspace"
        data-composer-shortcut="composer.workspace"
        data-composer-context-control
        disabled={containerPending}
        onMouseDownCapture={stopContextMenuMouseDown}
      >
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            {workspaceIcon}
          </TooltipTrigger>
          <TooltipPopup>
            {workspaceLabel}
            {shortcutLabel ? ` · ${shortcutLabel}` : null}
          </TooltipPopup>
        </Tooltip>
        <ComposerContextLabel>{workspaceLabel}</ComposerContextLabel>
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="top"
        sideOffset={4}
        width="content"
        {...composerFloatingLayerProps}
      >
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={containerValue ?? effectiveEnvMode}
            onValueChange={(value) => {
              if (value.startsWith("container:")) {
                onContainerSelect?.(value);
                return;
              }
              if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
                onUsePreviousWorktree?.();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem value="local" closeOnClick>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <span className="min-w-0 truncate">
                  {resolveCurrentWorkspaceLabel(activeWorktreePath)}
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="worktree" closeOnClick>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {showPreviousWorktree && previousWorktreeLabel ? (
              <MenuRadioItem value={PREVIOUS_WORKTREE_SELECT_VALUE} closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
            {containerFreshItem}
          </MenuRadioGroup>
          {containerExistingItem}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
