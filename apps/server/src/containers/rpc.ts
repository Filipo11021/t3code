import { WS_METHODS, type ContainerActionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ContainerWorkspaces from "./ContainerWorkspaces.ts";
import * as ContainerSubmissions from "./ContainerSubmissions.ts";

export const handlers = Effect.gen(function* () {
  const service = yield* ContainerWorkspaces.ContainerWorkspaces;
  const submissions = yield* ContainerSubmissions.ContainerSubmissions;
  return {
    [WS_METHODS.containerGuestSubmit]: submissions.submit,
    [WS_METHODS.containerGuestInspect]: submissions.inspect,
    [WS_METHODS.containersOpen]: service.open,
    [WS_METHODS.containersSettings]: service.settings,
    [WS_METHODS.containersConfigure]: service.configure,
    [WS_METHODS.containersConfigureProject]: service.configureProject,
    [WS_METHODS.containersAct]: (input: ContainerActionInput) => service.act(input),
    [WS_METHODS.containersCleanup]: () => service.idle.pipe(Effect.andThen(service.cleanup)),
    [WS_METHODS.containersChangeProvider]: service.changeProvider,
    [WS_METHODS.containersWake]: service.wake,
  };
});
