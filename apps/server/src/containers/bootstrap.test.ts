import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CONTAINER_CONFIG } from "@t3tools/contracts";
import { bootstrapScript, guestEnvironment } from "./bootstrap.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../processRunner.ts";

describe("container bootstrap", () => {
  it.live(
    "executes generated hooks across retained-home recreation, restart and failed installation retry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs.makeTempDirectoryScoped({
          directory: "/tmp/opencode",
          prefix: "container-hooks-",
        });
        const home = `${root}/home`;
        const runtime = `${root}/runtime`;
        yield* fs.makeDirectory(`${home}/.t3`, { recursive: true });
        yield* fs.makeDirectory(runtime);
        yield* fs.writeFileString(`${home}/sentinel`, "home");
        yield* fs.writeFileString(`${home}/.t3/state`, "history");
        yield* fs.writeFileString(`${runtime}/t3`, "#!/bin/bash\nexit 0\n");
        yield* fs.chmod(`${runtime}/t3`, 0o755);
        const generated = bootstrapScript({
          uid: 1000,
          gid: 1000,
          checkout: root,
          revision: "revision",
          config: {
            ...DEFAULT_CONTAINER_CONFIG,
            installScript: `echo attempt >> '${home}/attempts'\n[ ! -f '${home}/fail' ] || exit 1\necho installed > '${runtime}/tool'`,
            startScript: `echo start >> '${home}/starts'`,
          },
        });
        const controlled = generated
          .replaceAll("/home/t3", home)
          .replaceAll("/opt/t3", runtime)
          .replaceAll("/var/lib/t3-bootstrap-ready", `${root}/base-ready`)
          .replace("exec runuser", "runuser");
        const boundary = `apt-get() { :; }\ngetent() { return 0; }\nusermod() { :; }\nuseradd() { :; }\nchown() { :; }\nrunuser() { shift 3; "$@"; }\nexport -f runuser\n`;
        const script = `${root}/bootstrap.sh`;
        yield* fs.writeFileString(script, boundary + controlled);
        const run = runner.run({ command: "/bin/bash", args: [script] });
        expect((yield* run).code).toBe(0);
        expect(yield* fs.readFileString(`${runtime}/tool`)).toBe("installed\n");
        expect((yield* run).code).toBe(0);
        expect(yield* fs.readFileString(`${home}/attempts`)).toBe("attempt\n");
        expect(yield* fs.readFileString(`${home}/starts`)).toBe("start\nstart\n");
        yield* fs.remove(`${runtime}/tool`);
        yield* fs.remove(`${home}/.installed-revision`);
        yield* fs.writeFileString(`${home}/fail`, "fail");
        expect((yield* run).code).not.toBe(0);
        expect(yield* fs.exists(`${home}/.installed-revision`)).toBe(false);
        yield* fs.remove(`${home}/fail`);
        expect((yield* run).code).toBe(0);
        expect(yield* fs.readFileString(`${home}/attempts`)).toBe("attempt\nattempt\nattempt\n");
        expect(yield* fs.readFileString(`${runtime}/tool`)).toBe("installed\n");
        expect(yield* fs.readFileString(`${home}/sentinel`)).toBe("home");
        expect(yield* fs.readFileString(`${home}/.t3/state`)).toBe("history");
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
  it("runs revision-marked installation and finite start hooks as a non-root guest with an empty environment", () => {
    const script = bootstrapScript({
      uid: 1000,
      gid: 1000,
      checkout: "/repo/it's shared",
      revision: "abc123",
      config: {
        ...DEFAULT_CONTAINER_CONFIG,
        installScript: "printf install",
        startScript: "printf start",
        environment: { CUSTOM: "a 'value'" },
      },
    });
    expect(script).toContain("env -i HOME=/home/t3");
    expect(script).toContain("runuser -u t3");
    expect(script).toContain(".installed-abc123");
    expect(script.indexOf("printf install")).toBeLessThan(
      script.indexOf("touch /home/t3/.installed-abc123"),
    );
    expect(script.indexOf("printf start")).toBeGreaterThan(
      script.indexOf("touch /home/t3/.installed-abc123"),
    );
    expect(script).toContain("/opt/t3/t3 --base-dir /home/t3/.t3");
    expect(script).not.toContain("npx");
    expect(script).not.toContain("/var/run/docker.sock");
  });
  it.each(["HOME", "PATH", "LD_PRELOAD", "NODE_OPTIONS", "T3CODE_HOME"])(
    "rejects a bootstrap environment override of %s",
    (key) => {
      expect(() =>
        guestEnvironment({ ...DEFAULT_CONTAINER_CONFIG, environment: { [key]: "unsafe" } }),
      ).toThrowError(
        expect.objectContaining({ stage: "environment", reason: "invalid-environment" }),
      );
    },
  );
});
