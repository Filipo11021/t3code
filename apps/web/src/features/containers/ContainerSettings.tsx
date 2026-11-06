import { use, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CONTAINER_RUNTIME_KINDS,
  ContainerCleanupRules,
  ContainerOperationId,
  DEFAULT_CONTAINER_CONFIG,
  DEFAULT_CONTAINER_IDLE_MINUTES,
  CONTAINER_MAX_IDLE_MINUTES,
  CONTAINER_MAX_REMOVAL_DAYS,
  type ContainerRuntimeKind,
  type ContainerSettings,
  type ContainerSetup,
  type EnvironmentId,
  type ProjectId,
  type ProjectContainerCleanup,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { ensureLocalApi } from "../../localApi";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsSection,
  SettingsRow,
  SettingResetButton,
} from "../../components/settings/settingsLayout";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { RetentionControl } from "../../components/settings/RetentionControl";
import { newDraftId } from "../../lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ContainerEnvironmentSetup } from "./ContainerEnvironmentSetup";
import {
  containerActivityLabel,
  containerRuntimeLabel,
  containerRuntimeStatus,
  containerSettingsTargets,
} from "./selection";
import { useContainerRuntimeOverview } from "./useContainerRuntimeOverview";

const validCleanup = Schema.is(ContainerCleanupRules);
const bounded = (value: number | null, maximum: number) =>
  value !== null && Number.isInteger(value) && value >= 1 && value <= maximum ? value : null;
const writableRules = (rules: ContainerCleanupRules): ContainerCleanupRules => ({
  idleStopMinutes: bounded(rules.idleStopMinutes, CONTAINER_MAX_IDLE_MINUTES),
  removeAfterDays: bounded(rules.removeAfterDays, CONTAINER_MAX_REMOVAL_DAYS),
});
const toSetup = (config: ContainerSetup): ContainerSetup => ({
  image: config.image,
  installScript: config.installScript,
  startScript: config.startScript,
  environment: config.environment,
});
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Container operation failed.";

function ContainerRuntimeSection() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environments = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.containerWorkspaces === true,
  );
  const projectIdsByEnvironment = new Map<EnvironmentId, Array<ProjectId>>();
  for (const target of containerSettingsTargets(scope)) {
    if (target.projectId === null) continue;
    const ids = projectIdsByEnvironment.get(target.environmentId) ?? [];
    ids.push(target.projectId);
    projectIdsByEnvironment.set(target.environmentId, ids);
  }
  const targets = environments.map((environment) => {
    const projectIds = projectIdsByEnvironment.get(environment.environmentId) ?? [];
    return {
      environmentId: environment.environmentId,
      projectId: projectIds.length === 1 ? (projectIds[0] ?? null) : null,
    };
  });
  const overview = useContainerRuntimeOverview({
    targets,
    revisionKey: settings.containerRuntime,
  });
  const statusFor = (runtime: ContainerRuntimeKind) => {
    const statuses = [...overview.entries.values()].flatMap((entry) => {
      const status = entry.runtimes.find((candidate) => candidate.runtime === runtime);
      return status ? [status] : [];
    });
    if (statuses.length === 0) return null;
    if (statuses.every((status) => status.available)) return "Available";
    return statuses.some((status) => status.available) ? "Available on some" : "Unavailable";
  };
  const unavailableLabels = environments.flatMap((environment) => {
    const entry = overview.entries.get(environment.environmentId);
    if (!entry) return [];
    const status = entry.runtimes.find((candidate) => candidate.runtime === entry.runtime.resolved);
    return status?.available === false ? [environment.label] : [];
  });
  return (
    <SettingsSection id="container-runtime" title="Container runtime">
      <p className="text-sm text-muted-foreground">
        Docker and Podman are detected on the host. New containers use the selected runtime.
        Existing containers keep their recorded runtime and idle when their guest has no running
        work. Adjust the idle window under Container cleanup.
      </p>
      <SettingsRow
        serverScoped
        settingKeys={["containerRuntime"]}
        title="Default container runtime"
        description="New containers use this runtime here. Existing containers keep their recorded runtime."
        resetAction={
          settings.containerRuntime !== "docker" ? (
            <SettingResetButton
              label="default container runtime"
              onClick={() => updateSettings({ containerRuntime: "docker" })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.containerRuntime}
            onValueChange={(value) =>
              updateSettings({ containerRuntime: value as ContainerRuntimeKind })
            }
          >
            <SelectTrigger aria-label="Default container runtime">
              <SelectValue>{containerRuntimeLabel(settings.containerRuntime)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {CONTAINER_RUNTIME_KINDS.map((runtime) => {
                const status = statusFor(runtime);
                return (
                  <SelectItem key={runtime} value={runtime}>
                    {containerRuntimeLabel(runtime)}
                    {status ? ` · ${status}` : ""}
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        }
      />
      {unavailableLabels.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {unavailableLabels.join(", ")} {unavailableLabels.length === 1 ? "does" : "do"} not have
          the selected runtime available. Start it or choose an available runtime. Existing
          containers keep their recorded runtime.
        </p>
      ) : null}
      <div className="space-y-4">
        {environments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect an environment to check Docker and Podman.
          </p>
        ) : null}
        {environments.map((environment) => {
          const entry = overview.entries.get(environment.environmentId);
          const error = overview.errors.get(environment.environmentId);
          return (
            <div key={environment.environmentId} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{environment.label}</h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={overview.pending}
                  onClick={overview.refresh}
                >
                  Check again
                </Button>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                {CONTAINER_RUNTIME_KINDS.map((runtime) => {
                  const status = entry?.runtimes.find((candidate) => candidate.runtime === runtime);
                  const count =
                    entry?.workspaces.filter((workspace) => workspace.runtime === runtime).length ??
                    0;
                  return (
                    <div key={runtime} className="space-y-1 rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {containerRuntimeLabel(runtime)}
                        </span>
                        {status ? (
                          <Badge size="sm" variant={status.available ? "success" : "warning"}>
                            {status.available ? "Available" : "Unavailable"}
                          </Badge>
                        ) : (
                          <Badge size="sm" variant="outline">
                            {overview.pending ? "Checking" : "Not checked"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {status?.available
                          ? (status.version ?? "Version unavailable")
                          : (status?.detail ?? "No status reported.")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Used by {count} {count === 1 ? "container" : "containers"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function ContainerSettingsForTarget({
  environmentId,
  environmentLabel,
  projectId,
  label,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  projectId: ProjectId | null;
  label: string;
}) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const allowed = useAtomValue(
    serverEnvironment.containers.configureProject.permissionAtom(environmentId),
  );
  const [data, setData] = useState<ContainerSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useStableCallback(async (signal?: AbortSignal, refreshRuntimes = false) => {
    const result = await runAtomCommand(
      registry,
      serverEnvironment.containers.settings,
      {
        environmentId,
        input: {
          ...(projectId ? { projectId } : {}),
          ...(refreshRuntimes ? { refreshRuntimes: true } : {}),
        },
      },
      { reportFailure: false },
    );
    if (signal?.aborted) return;
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    if (projectId && result.value.project?.projectId !== projectId)
      throw new Error("Update this host for project container settings.");
    setData(result.value);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the concrete environment-local project selected by Settings scope.
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch((cause) => {
      if (!abort.signal.aborted) setError(message(cause));
    });
    return () => abort.abort();
  }, [load]);
  const perform = async (work: () => Promise<void>, refreshRuntimes = false) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
      await load(undefined, refreshRuntimes);
    } catch (cause) {
      setError(message(cause));
    }
    setPending(false);
  };
  const saveSetup = async (value: ContainerSetup) => {
    const result = projectId
      ? await runAtomCommand(
          registry,
          serverEnvironment.containers.configureProject,
          {
            environmentId,
            input: {
              kind: "setup",
              projectId,
              expectedRevision: data?.project?.setup?.revision ?? null,
              value,
            },
          },
          { reportFailure: false },
        )
      : await runAtomCommand(
          registry,
          serverEnvironment.containers.configure,
          {
            environmentId,
            input: { ...value, cleanup: data?.config.cleanup ?? DEFAULT_CONTAINER_CONFIG.cleanup },
          },
          { reportFailure: false },
        );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  };
  const policy = data?.project?.cleanup?.value ?? { kind: "inherit" as const };
  const rules =
    projectId && policy.kind === "off"
      ? DEFAULT_CONTAINER_CONFIG.cleanup
      : projectId && policy.kind === "custom"
        ? policy.rules
        : (data?.config.cleanup ?? DEFAULT_CONTAINER_CONFIG.cleanup);
  const saveCleanup = async (value: ProjectContainerCleanup) => {
    if (!data) return;
    const result = projectId
      ? await runAtomCommand(
          registry,
          serverEnvironment.containers.configureProject,
          {
            environmentId,
            input: {
              kind: "cleanup",
              projectId,
              expectedRevision: data.project?.cleanup?.revision ?? null,
              value,
            },
          },
          { reportFailure: false },
        )
      : await runAtomCommand(
          registry,
          serverEnvironment.containers.configure,
          {
            environmentId,
            input: {
              ...data.config,
              cleanup: value.kind === "custom" ? value.rules : DEFAULT_CONTAINER_CONFIG.cleanup,
            },
          },
          { reportFailure: false },
        );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  };
  const disabled = pending || !allowed || !data?.available;
  return (
    <div className="space-y-6 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{label}</h3>
        <span className="text-xs text-muted-foreground">{environmentLabel}</span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error} Other targets are unaffected.
        </p>
      ) : null}
      {!allowed ? (
        <p className="text-sm text-muted-foreground">Full host maintenance access is required.</p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => void perform(async () => {}, true)}
      >
        Refresh this target
      </Button>
      {data ? (
        <>
          <ContainerEnvironmentSetup
            key={JSON.stringify(data.project?.setup ?? data.config)}
            title={projectId ? "Project environment" : "Defaults for unconfirmed projects"}
            initial={data.project?.setup?.value ?? toSetup(data.config)}
            disabled={disabled}
            onSave={async (value) => {
              setPending(true);
              try {
                await saveSetup(value);
                await load();
                setPending(false);
              } catch (cause) {
                setPending(false);
                throw cause;
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void perform(() =>
                saveSetup(toSetup(projectId ? data.config : DEFAULT_CONTAINER_CONFIG)),
              )
            }
          >
            Reset setup to {projectId ? "host defaults" : "Ubuntu defaults"}
          </Button>
          <div className="space-y-2">
            <SettingsRow
              title="Container cleanup"
              description="Only managed runtimes are stopped or removed. Source files, guest home, credentials and history stay. Unknown or busy guests are retained."
              control={
                projectId ? (
                  <Select
                    value={policy.kind}
                    disabled={disabled}
                    onValueChange={(kind) => {
                      if (kind === "inherit" || kind === "off")
                        void perform(() => saveCleanup({ kind }));
                      else if (kind === "custom")
                        void perform(() =>
                          saveCleanup({
                            kind,
                            rules: writableRules(rules),
                          }),
                        );
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>
                        {policy.kind === "inherit"
                          ? "Inherit"
                          : policy.kind === "off"
                            ? "Off"
                            : "Custom"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="inherit">Inherit</SelectItem>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void perform(() => saveCleanup({ kind: "off" }))}
                  >
                    Reset cleanup
                  </Button>
                )
              }
            />
            {!validCleanup(rules) ? (
              <p className="text-sm text-muted-foreground">
                Legacy cleanup is outside supported limits. Automatic cleanup retains runtimes until
                corrected.
              </p>
            ) : null}
            <SettingsRow
              title="Idle after"
              description="Stop this container after its guest reports no running work for this long. Wake it from its thread to continue."
              control={
                <RetentionControl
                  label="Container idle stop"
                  value={rules.idleStopMinutes}
                  maximum={CONTAINER_MAX_IDLE_MINUTES}
                  unit="minutes"
                  enabledValue={DEFAULT_CONTAINER_IDLE_MINUTES}
                  disabled={disabled || Boolean(projectId && policy.kind !== "custom")}
                  onChange={(idleStopMinutes) =>
                    void perform(() =>
                      saveCleanup({
                        kind: "custom",
                        rules: writableRules({ ...rules, idleStopMinutes }),
                      }),
                    )
                  }
                />
              }
            />
            <SettingsRow
              title="Remove runtime after inactivity"
              description="Reopen recreates the runtime using its retained setup and home. It does not delete a checkout or thread."
              control={
                <RetentionControl
                  label="Container runtime retention"
                  value={rules.removeAfterDays}
                  maximum={CONTAINER_MAX_REMOVAL_DAYS}
                  disabled={disabled || Boolean(projectId && policy.kind !== "custom")}
                  onChange={(removeAfterDays) =>
                    void perform(() =>
                      saveCleanup({
                        kind: "custom",
                        rules: writableRules({ ...rules, removeAfterDays }),
                      }),
                    )
                  }
                />
              }
            />
          </div>
          <div className="space-y-3">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void perform(async () => {
                  const result = await runAtomCommand(
                    registry,
                    serverEnvironment.containers.cleanup,
                    { environmentId, input: undefined },
                    { reportFailure: false },
                  );
                  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
                })
              }
            >
              Run idle cleanup now
            </Button>
            {data.workspaces.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Select New container in an unsent draft, then Send. Managed containers for this
                project appear directly in that menu.
              </p>
            ) : null}
            {data.workspaces.map((workspace) => {
              const currentRuntime = containerRuntimeLabel(workspace.runtime);
              const runtimeUnavailable =
                containerRuntimeStatus(data, workspace.runtime)?.available === false;
              const otherRuntime = CONTAINER_RUNTIME_KINDS.find(
                (runtime) => runtime !== workspace.runtime,
              );
              const otherRuntimeAvailable = data.runtimes.some(
                (status) => status.runtime !== workspace.runtime && status.available,
              );
              return (
                <div key={workspace.id} className="space-y-2 rounded-md border p-3">
                  <p className="break-all text-sm">{workspace.checkoutPath}</p>
                  <p className="text-xs text-muted-foreground">
                    {workspace.image} · {currentRuntime} ·{" "}
                    {containerActivityLabel(workspace.status)}
                  </p>
                  {runtimeUnavailable ? (
                    <p role="alert" className="text-sm text-destructive">
                      {currentRuntime} is unavailable. Change this container to an available runtime
                      to continue.
                    </p>
                  ) : null}
                  {workspace.status.type === "failed" ? (
                    <p role="alert" className="text-sm text-destructive">
                      {workspace.status.error}
                    </p>
                  ) : null}
                  <SettingsRow
                    title="Runtime"
                    description="Changing runtime recreates the container. Guest home, checkout, installs and threads stay."
                    control={
                      <Select
                        value={workspace.runtime}
                        disabled={
                          disabled || workspace.ownership !== "managed" || !otherRuntimeAvailable
                        }
                        onValueChange={(value) => {
                          const runtime = value as ContainerRuntimeKind;
                          if (runtime === workspace.runtime) return;
                          void (async () => {
                            const label = containerRuntimeLabel(runtime);
                            if (
                              !(await ensureLocalApi().dialogs.confirm(
                                `Switch this container to ${label}? The guest home, checkout, installs and threads stay, but the runtime restarts on ${label}.`,
                              ))
                            )
                              return;
                            await perform(async () => {
                              const result = await runAtomCommand(
                                registry,
                                serverEnvironment.containers.changeRuntime,
                                {
                                  environmentId,
                                  input: { workspaceId: workspace.id, runtime },
                                },
                                { reportFailure: false },
                              );
                              if (result._tag !== "Success") throw squashAtomCommandFailure(result);
                            });
                          })();
                        }}
                      >
                        <SelectTrigger aria-label="Container runtime">
                          <SelectValue>{currentRuntime}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value={workspace.runtime} disabled>
                            {currentRuntime} · current
                          </SelectItem>
                          {data.runtimes
                            .filter(
                              (status) => status.runtime !== workspace.runtime && status.available,
                            )
                            .map((status) => (
                              <SelectItem key={status.runtime} value={status.runtime}>
                                {containerRuntimeLabel(status.runtime)}
                              </SelectItem>
                            ))}
                        </SelectPopup>
                      </Select>
                    }
                  />
                  {!otherRuntimeAvailable && otherRuntime ? (
                    <p className="text-xs text-muted-foreground">
                      Start {currentRuntime} or install {containerRuntimeLabel(otherRuntime)} to
                      change runtime.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || runtimeUnavailable}
                      onClick={() =>
                        void perform(async () => {
                          const opened = await runAtomCommand(
                            registry,
                            serverEnvironment.containers.open,
                            {
                              environmentId,
                              input: {
                                operationId: ContainerOperationId.make(newDraftId()),
                                projectId: workspace.projectId,
                                checkoutPath: workspace.checkoutPath,
                                selection: { type: "existing", workspaceId: workspace.id },
                              },
                            },
                            { reportFailure: false },
                          );
                          if (opened._tag !== "Success") throw squashAtomCommandFailure(opened);
                          const connected = await runAtomCommand(
                            registry,
                            serverEnvironment.containers.connect,
                            opened.value,
                            { reportFailure: false },
                          );
                          if (connected._tag !== "Success")
                            throw squashAtomCommandFailure(connected);
                          await navigate({
                            to: "/settings/providers",
                            search: { machine: opened.value.guestEnvironmentId },
                          });
                        })
                      }
                    >
                      Open guest setup
                    </Button>
                    {(["stop", "restart", "remove-runtime"] as const).map((action) => (
                      <Button
                        key={action}
                        size="sm"
                        variant={action === "remove-runtime" ? "destructive" : "outline"}
                        disabled={
                          disabled || runtimeUnavailable || workspace.ownership !== "managed"
                        }
                        onClick={() =>
                          void perform(async () => {
                            if (
                              action === "remove-runtime" &&
                              !(await ensureLocalApi().dialogs.confirm(
                                "Remove this runtime? Guest home, history and checkout files are retained.",
                                { variant: "destructive" },
                              ))
                            )
                              return;
                            const result = await runAtomCommand(
                              registry,
                              serverEnvironment.containers.act,
                              { environmentId, input: { workspaceId: workspace.id, action } },
                              { reportFailure: false },
                            );
                            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
                          })
                        }
                      >
                        {action === "remove-runtime"
                          ? "Remove runtime"
                          : action === "restart"
                            ? "Restart"
                            : "Stop"}
                      </Button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-sm">
          Container settings unavailable or loading. Refresh this target to retry.
        </p>
      )}
    </div>
  );
}

export function ContainerSettingsPanel() {
  const { scope, environments } = useSettingsScope();
  const targets = containerSettingsTargets(scope);
  return (
    <SettingsPageContainer>
      <ContainerRuntimeSection />
      <SettingsSection id="container-setup" title="Container environments">
        <p className="text-sm text-muted-foreground">
          Setup belongs to each environment-local project. Checkout scope edits its owning project.
          Each target below saves independently, including in aggregate scope. Native mobile
          creation and setup are not supported.
        </p>
        {scope.kind === "unavailable" ? <p role="alert">{scope.message}</p> : null}
        {targets.length === 0 ? (
          <p className="text-sm">Choose a host or project to edit container setup.</p>
        ) : null}
        {targets.map((target) => {
          const environment = environments.find(
            (environment) => environment.environmentId === target.environmentId,
          );
          const key = `${target.environmentId}:${target.projectId ?? "host"}`;
          return environment?.connection.phase === "connected" &&
            environment.serverConfig?.environment.capabilities.containerProjects === true ? (
            <ContainerSettingsForTarget
              key={key}
              {...target}
              environmentLabel={environment.label}
            />
          ) : (
            <p key={key} role="status" className="text-sm text-muted-foreground">
              {target.label} · {environment?.label ?? target.environmentId} is offline, unsupported,
              or needs a host update. No settings were saved there.
            </p>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
