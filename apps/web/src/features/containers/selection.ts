import {
  CONTAINER_PROVIDER_LABELS,
  type ContainerProviderKind,
  type ContainerProviderStatus,
  type ContainerSettings,
  type ContainerStatus,
} from "@t3tools/contracts";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";

export type ContainerPickerOption = { readonly value: string; readonly label: string };
export const checkoutLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
export const containerProviderLabel = (provider: ContainerProviderKind) =>
  CONTAINER_PROVIDER_LABELS[provider];
export function containerProviderStatus(
  settings: ContainerSettings | null,
  provider: ContainerProviderKind,
): ContainerProviderStatus | null {
  return settings?.providers.find((status) => status.provider === provider) ?? null;
}
export function containerActivityLabel(
  status: ContainerStatus,
): "Starting" | "Active" | "Idle" | "Failed" {
  switch (status.type) {
    case "provisioning":
      return "Starting";
    case "ready":
      return "Active";
    case "stopped":
    case "removed":
      return "Idle";
    case "failed":
      return "Failed";
  }
}
export function containerOptions(
  settings: ContainerSettings | null,
): ReadonlyArray<ContainerPickerOption> {
  const workspaces = [...(settings?.workspaces ?? [])]
    .filter((workspace) => workspace.ownership === "managed")
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  const checkoutLabels = workspaces.map((workspace) => checkoutLabel(workspace.checkoutPath));
  const duplicated = new Set(
    checkoutLabels.filter((label, index) => checkoutLabels.indexOf(label) !== index),
  );
  return [
    { value: "container:fresh", label: "New container" },
    ...workspaces.map((workspace, index) => {
      const label = checkoutLabels[index]!;
      const suffix = duplicated.has(label) ? ` · ${workspace.id.slice(0, 8)}` : "";
      return {
        value: `container:${workspace.id}`,
        label: `${label} · ${containerActivityLabel(workspace.status)}${suffix}`,
      };
    }),
  ];
}
export function containerSettingsTargets(scope: ResolvedSettingsScope) {
  if (scope.kind === "unavailable") return [];
  return scope.kind === "project" || scope.kind === "checkout"
    ? scope.members.map((member) => {
        const checkout = checkoutLabel(member.workspaceRoot);
        return {
          environmentId: member.environmentId,
          projectId: member.id,
          label: member.title === checkout ? member.title : `${member.title} · ${checkout}`,
        };
      })
    : scope.environmentIds.map((environmentId) => ({
        environmentId,
        projectId: null,
        label: "Host defaults",
      }));
}
