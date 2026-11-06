import {
  type ContainerOperationId,
  type ContainerProviderKind,
  type ContainerWorkspaceId,
  type EnvironmentId,
} from "@t3tools/contracts";

export type ContainerCreateInput = {
  readonly provider: ContainerProviderKind;
  readonly workspaceId: ContainerWorkspaceId;
  readonly name: string;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly operationId: ContainerOperationId;
  readonly revision: string;
  readonly image: string;
  readonly checkoutPath: string;
  readonly directory: string;
  readonly mounts: ReadonlyArray<{
    readonly source: string;
    readonly target: string;
    readonly readonly?: boolean;
  }>;
  readonly homePath: string;
  readonly runtimePath: string;
  readonly scriptPath: string;
};

export type ContainerExecOptions = {
  readonly user?: string;
  readonly env?: Readonly<Record<string, string>>;
};
