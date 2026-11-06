import type { ContainerSettings } from "@t3tools/contracts";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";

export type ContainerPickerOption = { readonly value: string; readonly label: string };
export function containerOptions(
  settings: ContainerSettings | null,
): ReadonlyArray<ContainerPickerOption> {
  return [
    { value: "container:fresh", label: "New container" },
    ...(settings?.workspaces ?? [])
      .filter((workspace) => workspace.ownership === "managed")
      .map((workspace) => ({
        value: `container:${workspace.id}`,
        label: `${workspace.id.slice(0, 8)} · ${workspace.checkoutPath} · ${workspace.status.type === "failed" || workspace.status.type === "provisioning" ? `retry ${workspace.status.type}` : workspace.status.type}`,
      })),
  ];
}
export function containerSettingsTargets(scope: ResolvedSettingsScope) {
  if (scope.kind === "unavailable") return [];
  return scope.kind === "project" || scope.kind === "checkout"
    ? scope.members.map((member) => ({
        environmentId: member.environmentId,
        projectId: member.id,
        label: `${member.title} · ${member.workspaceRoot}`,
      }))
    : scope.environmentIds.map((environmentId) => ({
        environmentId,
        projectId: null,
        label: "Host defaults",
      }));
}
