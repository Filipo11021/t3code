import { use, useEffect, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import type {
  ContainerRuntimeStatus,
  ContainerSettings,
  ContainerWorkspace,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useStableCallback } from "../../hooks/useStableCallback";

export interface ContainerRuntimeOverviewTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}
export interface ContainerRuntimeOverviewEntry {
  readonly runtime: ContainerSettings["runtime"];
  readonly runtimes: ReadonlyArray<ContainerRuntimeStatus>;
  readonly workspaces: ReadonlyArray<ContainerWorkspace>;
}
interface OverviewState {
  readonly key: string;
  readonly entries: ReadonlyMap<EnvironmentId, ContainerRuntimeOverviewEntry>;
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
  cause instanceof Error ? cause.message : "Container runtime status is unavailable.";

export function useContainerRuntimeOverview(input: {
  readonly targets: ReadonlyArray<ContainerRuntimeOverviewTarget>;
}) {
  const registry = use(RegistryContext);
  const key = JSON.stringify(input.targets);
  const [state, setState] = useState<OverviewState>(emptyState(key));
  const load = useStableCallback(
    async (targetsKey: string, refreshRuntimes: boolean, signal?: AbortSignal) => {
      const targets = JSON.parse(targetsKey) as ReadonlyArray<ContainerRuntimeOverviewTarget>;
      setState((current) => ({
        ...(current.key === targetsKey ? current : emptyState(targetsKey)),
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
                ...(refreshRuntimes ? { refreshRuntimes: true } : {}),
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
              runtime: result.value.runtime,
              runtimes: result.value.runtimes,
              workspaces: result.value.workspaces,
            },
          } as const;
        }),
      );
      if (signal?.aborted) return;
      const entries = new Map<EnvironmentId, ContainerRuntimeOverviewEntry>();
      const errors = new Map<EnvironmentId, string>();
      for (const result of results) {
        if (result === null) continue;
        if ("error" in result) errors.set(result.target.environmentId, result.error);
        else entries.set(result.target.environmentId, result.entry);
      }
      setState({ key: targetsKey, entries, errors, pending: false });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Probe each selected environment's runtime availability from Settings.
  useEffect(() => {
    const abort = new AbortController();
    void load(key, false, abort.signal);
    return () => abort.abort();
  }, [load, key]);
  const current = state.key === key ? state : emptyState(key);
  return {
    entries: current.entries,
    errors: current.errors,
    pending: current.pending,
    refresh: () => void load(key, true),
  };
}
