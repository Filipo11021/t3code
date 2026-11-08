import { CommandId, ContainerError, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ContainerGuest extends Context.Service<
  ContainerGuest,
  {
    readonly prepare: (checkout: string) => Effect.Effect<
      {
        readonly environmentId: import("@t3tools/contracts").EnvironmentId;
        readonly projectId: import("@t3tools/contracts").ProjectId;
      },
      ContainerError
    >;
    readonly idle: Effect.Effect<boolean, ContainerError>;
  }
>()("t3/containers/GuestService/ContainerGuest") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const sql = yield* SqlClient.SqlClient;
  const { basename } = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const prepare = Effect.fn("ContainerGuest.prepare")(function* (checkout: string) {
    const existing = yield* projects
      .getByWorkspaceRoot(checkout)
      .pipe(
        Effect.mapError(
          (cause) => new ContainerError({ stage: "project", reason: "guest-failed", cause }),
        ),
      );
    const project = Option.isSome(existing)
      ? existing.value
      : (yield* projects
          .bootstrap({
            workspaceRoot: checkout,
            title: basename(checkout),
            projectId: ProjectId.make("container-workspace"),
            commandId: CommandId.make(yield* random.uuidV4()),
          })
          .pipe(
            Effect.mapError(
              (cause) => new ContainerError({ stage: "project", reason: "guest-failed", cause }),
            ),
          )).project;
    const descriptor = yield* environment.getDescriptor;
    return { environmentId: descriptor.environmentId, projectId: project.id };
  });
  const idle = Effect.gen(function* () {
    const active = yield* projections.listActiveShellIndex();
    if (active.some((thread) => thread.mayBeLive)) return false;
    let terminalCount = 0;
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") terminalCount = event.terminals.length;
        else if (event.type === "upsert") terminalCount += 1;
      }),
    );
    unsubscribe();
    if (terminalCount > 0) return false;
    const effects = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running', 'failed')`;
    const schedules = yield* sql<{
      count: number;
    }>`SELECT count(*) AS count FROM scheduled_tasks WHERE enabled = 1`;
    return effects[0]?.count === 0 && schedules[0]?.count === 0;
  }).pipe(Effect.mapError((cause) => new ContainerError({ stage: "idle", reason: "busy", cause })));
  return ContainerGuest.of({ prepare, idle });
});
export const layer = Layer.effect(ContainerGuest, make);
