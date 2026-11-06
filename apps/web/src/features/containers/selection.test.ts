import { expect, describe, it } from "vite-plus/test";
import {
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
  type ContainerRuntimeStatus,
  type ContainerSettings,
  type ContainerWorkspace,
} from "@t3tools/contracts";
import {
  containerOptions,
  containerRuntimeLabel,
  containerRuntimeStatus,
  containerSettingsTargets,
} from "./selection";
import { resolveSettingsScope } from "../../components/settings/settingsScope";

const available = (runtime: "docker" | "podman"): ContainerRuntimeStatus => ({
  runtime,
  available: true,
  version: "test",
  detail: null,
  checkedAt: 0,
});
const unavailable = (runtime: "docker" | "podman"): ContainerRuntimeStatus => ({
  runtime,
  available: false,
  version: null,
  detail: "not installed",
  checkedAt: 0,
});
const workspace = (overrides: Partial<ContainerWorkspace> = {}): ContainerWorkspace => ({
  id: ContainerWorkspaceId.make("workspace-one"),
  ownership: "managed",
  projectId: ProjectId.make("project"),
  checkoutPath: "/repo/t3code",
  image: "ubuntu:26.04",
  runtime: "docker",
  status: { type: "stopped" },
  lastUsedAt: 0,
  ...overrides,
});
const settings = (overrides: Partial<ContainerSettings> = {}): ContainerSettings => ({
  config: DEFAULT_CONTAINER_CONFIG,
  runtime: { default: "docker", project: null, resolved: "docker" },
  runtimes: [available("docker"), available("podman")],
  workspaces: [],
  available: true,
  ...overrides,
});

describe("container runtime labels", () => {
  it("labels the fixed providers", () => {
    expect(containerRuntimeLabel("docker")).toBe("Docker");
    expect(containerRuntimeLabel("podman")).toBe("Podman");
  });

  it("finds the provider status by runtime", () => {
    const value = settings({ runtimes: [available("docker"), unavailable("podman")] });
    expect(containerRuntimeStatus(value, "podman")?.available).toBe(false);
    expect(containerRuntimeStatus(null, "docker")).toBeNull();
  });
});

describe("containerOptions", () => {
  it("labels a new container with the resolved runtime", () => {
    expect(containerOptions(settings())[0]).toEqual({
      value: "container:fresh",
      label: "New container · Docker",
    });
    expect(
      containerOptions(
        settings({
          runtime: { default: "podman", project: "podman", resolved: "podman" },
          runtimes: [unavailable("docker"), unavailable("podman")],
        }),
      )[0],
    ).toEqual({ value: "container:fresh", label: "New container · Podman (unavailable)" });
  });

  it("shows the recorded runtime and warns when it is unavailable", () => {
    expect(
      containerOptions(
        settings({
          workspaces: [
            workspace({ id: ContainerWorkspaceId.make("abcdefgh-one") }),
            workspace({ id: ContainerWorkspaceId.make("ijklmnop-two"), runtime: "podman" }),
          ],
          runtimes: [available("docker"), unavailable("podman")],
        }),
      ),
    ).toEqual([
      { value: "container:fresh", label: "New container · Docker" },
      {
        value: "container:abcdefgh-one",
        label: "abcdefgh · t3code · Docker · stopped",
      },
      {
        value: "container:ijklmnop-two",
        label: "ijklmnop · t3code · Podman (unavailable) · stopped",
      },
    ]);
  });
});

describe("containerSettingsTargets", () => {
  it("maps host scope to the environment default", () => {
    const environmentId = EnvironmentId.make("host");
    expect(
      containerSettingsTargets(resolveSettingsScope({}, [], [{ environmentId, label: "Host" }])),
    ).toEqual([{ environmentId, projectId: null, label: "Host defaults" }]);
  });
});
