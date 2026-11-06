import { use, useEffect, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import type {
  ContainerProviderStatus,
  ContainerSettings,
  ContainerWorkspace,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useStableCallback } from "../../hooks/useStableCallback";

export interface ContainerProviderOverviewTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}
export interface ContainerProviderOverviewEntry {
  readonly provider: ContainerSettings["provider"];
  readonly providers: ReadonlyArray<ContainerProviderStatus>;
  readonly workspaces: ReadonlyArray<ContainerWorkspace>;
}
interface OverviewState {
  readonly key: string;
  readonly entries: ReadonlyMap<EnvironmentId, ContainerProviderOverviewEntry>;
  readonly errors: ReadonlyMap<EnvironmentId, string>;
  readonly pending: boolean;
}
const emptyState = (key: string): OverviewState => ({
  key,
  entries: new Map(),
  errors: new Map(),
  pending: false,
});
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Container provider status is unavailable.";

export function useContainerProviderOverview(input: {
  readonly targets: ReadonlyArray<ContainerProviderOverviewTarget>;
  readonly revisionKey?: string;
}) {
  const registry = use(RegistryContext);
  const targetsKey = JSON.stringify(input.targets);
  const key = `${targetsKey}:${input.revisionKey ?? ""}`;
  const [state, setState] = useState<OverviewState>(emptyState(key));
  const load = useStableCallback(
    async (
      targetsKey: string,
      stateKey: string,
      refreshStatuses: boolean,
      signal?: AbortSignal,
    ) => {
      const targets = JSON.parse(targetsKey) as ReadonlyArray<ContainerProviderOverviewTarget>;
      setState((current) => ({
        ...(current.key === stateKey ? current : emptyState(stateKey)),
        pending: true,
      }));
      const results = await Promise.all(
        targets.map(async (target) => {
          const result = await runAtomCommand(
            registry,
            serverEnvironment.containers.settings,
            {
              environmentId: target.environmentId,
              input: {
                ...(target.projectId === null ? {} : { projectId: target.projectId }),
                ...(refreshStatuses ? { refreshProviders: true } : {}),
              },
            },
            { reportFailure: false },
          );
          if (signal?.aborted) return null;
          if (result._tag !== "Success") {
            return {
              target,
              error: message(squashAtomCommandFailure(result)),
            } as const;
          }
          return {
            target,
            entry: {
              provider: result.value.provider,
              providers: result.value.providers,
              workspaces: result.value.workspaces,
            },
          } as const;
        }),
      );
      if (signal?.aborted) return;
      const entries = new Map<EnvironmentId, ContainerProviderOverviewEntry>();
      const errors = new Map<EnvironmentId, string>();
      for (const result of results) {
        if (result === null) continue;
        if ("error" in result) errors.set(result.target.environmentId, result.error);
        else entries.set(result.target.environmentId, result.entry);
      }
      setState({ key: stateKey, entries, errors, pending: false });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Probe each selected environment's provider availability from Settings.
  useEffect(() => {
    const abort = new AbortController();
    void load(targetsKey, key, false, abort.signal);
    return () => abort.abort();
  }, [load, targetsKey, key]);
  const current = state.key === key ? state : emptyState(key);
  return {
    entries: current.entries,
    errors: current.errors,
    pending: current.pending,
    refresh: () => void load(targetsKey, key, true),
  };
}
