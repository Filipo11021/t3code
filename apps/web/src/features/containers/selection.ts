import {
  CONTAINER_RUNTIME_LABELS,
  type ContainerRuntimeKind,
  type ContainerRuntimeStatus,
  type ContainerSettings,
} from "@t3tools/contracts";
import type { ResolvedSettingsScope } from "../../components/settings/settingsScope";

export type ContainerPickerOption = { readonly value: string; readonly label: string };
export const checkoutLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
export const containerRuntimeLabel = (runtime: ContainerRuntimeKind) =>
  CONTAINER_RUNTIME_LABELS[runtime];
export function containerRuntimeStatus(
  settings: ContainerSettings | null,
  runtime: ContainerRuntimeKind,
): ContainerRuntimeStatus | null {
  return settings?.runtimes.find((status) => status.runtime === runtime) ?? null;
}
function runtimeLabel(settings: ContainerSettings | null, runtime: ContainerRuntimeKind) {
  const status = settings ? containerRuntimeStatus(settings, runtime) : null;
  return `${containerRuntimeLabel(runtime)}${status && !status.available ? " (unavailable)" : ""}`;
}
export function containerOptions(
  settings: ContainerSettings | null,
): ReadonlyArray<ContainerPickerOption> {
  return [
    {
      value: "container:fresh",
      label: settings
        ? `New container · ${runtimeLabel(settings, settings.runtime.resolved)}`
        : "New container",
    },
    ...(settings?.workspaces ?? [])
      .filter((workspace) => workspace.ownership === "managed")
      .map((workspace) => ({
        value: `container:${workspace.id}`,
        label: `${workspace.id.slice(0, 8)} · ${checkoutLabel(workspace.checkoutPath)} · ${runtimeLabel(settings, workspace.runtime)} · ${workspace.status.type === "failed" || workspace.status.type === "provisioning" ? `retry ${workspace.status.type}` : workspace.status.type}`,
      })),
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
