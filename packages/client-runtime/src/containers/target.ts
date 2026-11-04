import { ContainerWorkspaceId, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class ContainerConnectionTarget extends Schema.TaggedClass<ContainerConnectionTarget>()(
  "ContainerConnectionTarget",
  {
    environmentId: EnvironmentId,
    label: Schema.String,
    hostEnvironmentId: EnvironmentId,
    workspaceId: ContainerWorkspaceId,
  },
) {}

export class ContainerConnectionRegistration extends Schema.TaggedClass<ContainerConnectionRegistration>()(
  "ContainerConnectionRegistration",
  { target: ContainerConnectionTarget },
) {}
