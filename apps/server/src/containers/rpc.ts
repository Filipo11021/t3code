import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ContainerWorkspaces from "./ContainerWorkspaces.ts";

export const handlers = Effect.gen(function* () {
  const service = yield* ContainerWorkspaces.ContainerWorkspaces;
  return {
    [WS_METHODS.containersOpen]: service.open,
    [WS_METHODS.containersSettings]: service.settings,
    [WS_METHODS.containersConfigure]: service.configure,
    [WS_METHODS.containersConfigureProject]: service.configureProject,
    [WS_METHODS.containersAct]: service.act,
    [WS_METHODS.containersCleanup]: () => service.cleanup,
  };
});
