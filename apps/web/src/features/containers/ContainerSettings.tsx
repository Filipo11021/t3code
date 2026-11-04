import { use, useEffect, useState } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  ContainerConfig,
  ContainerOperationId,
  type ContainerActionInput,
  type ContainerSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { newDraftId } from "../../lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
const decodeConfig = Schema.decodeSync(ContainerConfig);
const decodeEnvironment = Schema.decodeSync(
  Schema.fromJsonString(ContainerConfig.fields.environment),
);

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Container operation failed.";

function ContainerConfigEditor({
  initial,
  onSave,
  disabled,
}: {
  initial: ContainerConfig;
  onSave: (value: ContainerConfig) => Promise<void>;
  disabled: boolean;
}) {
  const [image, setImage] = useState(initial.image);
  const [installScript, setInstallScript] = useState(initial.installScript);
  const [startScript, setStartScript] = useState(initial.startScript);
  const [environment, setEnvironment] = useState(JSON.stringify(initial.environment, null, 2));
  const [idle, setIdle] = useState(initial.cleanup.idleStopMinutes?.toString() ?? "");
  const [retention, setRetention] = useState(initial.cleanup.removeAfterDays?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const value = decodeConfig({
        image,
        installScript,
        startScript,
        environment: decodeEnvironment(environment),
        cleanup: {
          idleStopMinutes: idle.trim() ? Number(idle) : null,
          removeAfterDays: retention.trim() ? Number(retention) : null,
        },
      });
      await onSave(value);
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Changes apply to new containers. Reused containers keep their setup snapshot. Values are
        saved on this host, not in the browser.
      </p>
      <label className="grid gap-2 text-sm">
        Base image
        <Input
          aria-label="Container image"
          value={image}
          onChange={(event) => setImage(event.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="grid gap-2 text-sm">
        Install script
        <Textarea
          aria-label="Container install script"
          rows={4}
          value={installScript}
          onChange={(event) => setInstallScript(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Runs as the guest user once after success for this setup revision. Retrying a failure can
          repeat partially completed work.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Start script
        <Textarea
          aria-label="Container start script"
          rows={4}
          value={startScript}
          onChange={(event) => setStartScript(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          A finite hook on each container start. It must exit successfully before T3 starts.
          Background applications explicitly or use a guest terminal.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Environment variables as JSON
        <Textarea
          aria-label="Container environment variables"
          rows={4}
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Plain non-secret values only. Host credentials and environment variables are not copied.
          HOME, PATH, runtime flags, and T3 settings cannot be overridden.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Stop after idle minutes
        <Input
          aria-label="Container idle stop minutes"
          type="number"
          min={1}
          value={idle}
          onChange={(event) => setIdle(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Leave blank to keep running. Cleanup requires an idle guest with no running turn,
          terminal, pending effect, enabled schedule, or connected client. Unknown state is
          retained.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Remove runtime after inactive days
        <Input
          aria-label="Container runtime retention days"
          type="number"
          min={1}
          value={retention}
          onChange={(event) => setRetention(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Optional. Only managed runtimes are removed. Checkout files, guest home, credentials, and
          conversation history are retained. There is no automatic data purge.
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button disabled={disabled} onClick={() => void save()}>
        Save container settings
      </Button>
    </div>
  );
}

function ContainerSettingsForEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = use(RegistryContext);
  const navigate = useNavigate();
  const allowed = useAtomValue(
    serverEnvironment.containers.configure.permissionAtom(environmentId),
  );
  const [data, setData] = useState<ContainerSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useStableCallback(async (signal?: AbortSignal) => {
    const result = await runAtomCommand(
      registry,
      serverEnvironment.containers.settings,
      { environmentId, input: {} },
      { reportFailure: false },
    );
    if (signal?.aborted) return;
    if (result._tag === "Success") {
      setData(result.value);
      setError(null);
    } else setError(message(squashAtomCommandFailure(result)));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load environment-owned container configuration when this host opens.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const act = async (input: ContainerActionInput) => {
    if (
      input.action === "remove-runtime" &&
      !(await ensureLocalApi().dialogs.confirm(
        "Remove this managed container runtime? Guest home and conversation history are retained. Checkout files are not deleted.",
        { variant: "destructive" },
      ))
    )
      return;
    setPending(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      serverEnvironment.containers.act,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag !== "Success") setError(message(squashAtomCommandFailure(result)));
    else await load();
    setPending(false);
  };
  const connect = async (workspace: ContainerSettings["workspaces"][number]) => {
    setPending(true);
    setError(null);
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
    if (opened._tag !== "Success") setError(message(squashAtomCommandFailure(opened)));
    else {
      const connected = await runAtomCommand(
        registry,
        serverEnvironment.containers.connect,
        opened.value,
        { reportFailure: false },
      );
      if (connected._tag !== "Success") setError(message(squashAtomCommandFailure(connected)));
      else
        await navigate({
          to: "/settings/providers",
          search: { machine: opened.value.guestEnvironmentId },
        });
    }
    setPending(false);
  };
  return (
    <SettingsPageContainer>
      <SettingsSection id="container-setup" title="Container workspaces">
        <p className="text-sm text-muted-foreground">
          A full T3 environment runs inside each container. Source files and Git metadata are shared
          with the host. Provider installation and sign-in happen independently inside the guest.
          Requires Docker and a matching Linux T3 runtime. Native mobile setup is not available yet.
        </p>
        {!allowed ? (
          <p role="status" className="text-sm">
            Full host maintenance access is required for all container operations and guest access.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {data ? (
          <ContainerConfigEditor
            key={JSON.stringify(data.config)}
            initial={data.config}
            disabled={pending || !allowed}
            onSave={async (config) => {
              setPending(true);
              try {
                const result = await runAtomCommand(
                  registry,
                  serverEnvironment.containers.configure,
                  { environmentId, input: config },
                  { reportFailure: false },
                );
                if (result._tag !== "Success") throw squashAtomCommandFailure(result);
                await load();
              } finally {
                setPending(false);
              }
            }}
          />
        ) : (
          <p className="text-sm">Loading container settings…</p>
        )}
      </SettingsSection>
      <SettingsSection id="container-runtimes" title="Managed containers">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !allowed}
            onClick={() => void load()}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !allowed}
            onClick={() => {
              setPending(true);
              void runAtomCommand(
                registry,
                serverEnvironment.containers.cleanup,
                { environmentId, input: undefined },
                { reportFailure: false },
              ).then(async (result) => {
                if (result._tag !== "Success") setError(message(squashAtomCommandFailure(result)));
                else await load();
                setPending(false);
              });
            }}
          >
            Run idle cleanup
          </Button>
        </div>
        {data?.workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a fresh Ubuntu container from an unsent draft's workspace menu. Existing managed
            containers for that checkout can be reused there. Arbitrary external containers are
            preserved and are not eligible.
          </p>
        ) : null}
        <div className="space-y-4">
          {data?.workspaces.map((workspace) => (
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
                  disabled={pending || !allowed}
                  onClick={() => void connect(workspace)}
                >
                  Open guest setup
                </Button>
                {(["stop", "restart", "remove-runtime"] as const).map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === "remove-runtime" ? "destructive" : "outline"}
                    disabled={pending || !allowed || workspace.ownership !== "managed"}
                    onClick={() => void act({ workspaceId: workspace.id, action })}
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
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ContainerSettingsPanel() {
  const { environment } = useSettingsScope();
  if (
    !environment ||
    environment.serverConfig?.environment.capabilities.containerWorkspaces !== true
  )
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Choose a connected host that supports container workspaces. Container setup is not
          available inside a guest.
        </p>
      </SettingsPageContainer>
    );
  return (
    <ContainerSettingsForEnvironment
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}
