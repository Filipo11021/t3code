import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CONTAINER_CONFIG } from "@t3tools/contracts";
import { bootstrapScript, guestEnvironment } from "./bootstrap.ts";

describe("container bootstrap", () => {
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
