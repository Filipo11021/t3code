import { use, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ContainerCleanupRules,
  ContainerOperationId,
  DEFAULT_CONTAINER_CONFIG,
  CONTAINER_MAX_IDLE_MINUTES,
  CONTAINER_MAX_REMOVAL_DAYS,
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
} from "../../components/settings/settingsLayout";
import { RetentionControl } from "../../components/settings/RetentionControl";
import { newDraftId } from "../../lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ContainerEnvironmentSetup } from "./ContainerEnvironmentSetup";
import { containerSettingsTargets } from "./selection";

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
  const load = useStableCallback(async (signal?: AbortSignal) => {
    const result = await runAtomCommand(
      registry,
      serverEnvironment.containers.settings,
      { environmentId, input: projectId ? { projectId } : {} },
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
  const perform = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
      await load();
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
        onClick={() => void perform(async () => {})}
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
              title="Stop after idle"
              description="Requires positive guest idle evidence and no connected route."
              control={
                <RetentionControl
                  label="Container idle stop"
                  value={rules.idleStopMinutes}
                  maximum={CONTAINER_MAX_IDLE_MINUTES}
                  unit="minutes"
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
            {data.workspaces.map((workspace) => (
              <div key={workspace.id} className="space-y-2 rounded-md border p-3">
                <p className="break-all text-sm">{workspace.checkoutPath}</p>
                <p className="text-xs text-muted-foreground">
                  {workspace.image} · {workspace.id.slice(0, 8)} · {workspace.status.type}
                </p>
                {workspace.status.type === "failed" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {workspace.status.error}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
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
                        if (connected._tag !== "Success") throw squashAtomCommandFailure(connected);
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
                      disabled={disabled || workspace.ownership !== "managed"}
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
            ))}
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
