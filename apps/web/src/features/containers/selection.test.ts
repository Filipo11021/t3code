import { expect, describe, it } from "vite-plus/test";
import {
  ContainerWorkspaceId,
  DEFAULT_CONTAINER_CONFIG,
  EnvironmentId,
  ProjectId,
  type ContainerDestination,
  type ContainerRuntimeStatus,
  type ContainerSettings,
  type ContainerStatus,
  type ContainerWorkspace,
} from "@t3tools/contracts";
import {
  containerActivityLabel,
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
const destination: ContainerDestination = {
  hostEnvironmentId: EnvironmentId.make("host"),
  workspaceId: ContainerWorkspaceId.make("workspace-one"),
  guestEnvironmentId: EnvironmentId.make("guest"),
  guestProjectId: ProjectId.make("guest-project"),
  guestCheckoutPath: "/repo/t3code",
  runtime: "docker",
  label: "t3code · ubuntu:26.04",
};
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

describe("containerActivityLabel", () => {
  it.each([
    {
      name: "provisioning",
      status: { type: "provisioning", stage: "create" },
      label: "Starting",
    },
    { name: "ready", status: { type: "ready", destination }, label: "Active" },
    { name: "stopped", status: { type: "stopped" }, label: "Idle" },
    { name: "removed", status: { type: "removed", retainedData: true }, label: "Idle" },
    {
      name: "failed",
      status: { type: "failed", stage: "start", error: "boom" },
      label: "Failed",
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly status: ContainerStatus;
    readonly label: string;
  }>)("maps $name to $label", ({ status, label }) => {
    expect(containerActivityLabel(status)).toBe(label);
  });
});

describe("containerOptions", () => {
  it("labels a new container without runtime noise", () => {
    expect(containerOptions(settings())[0]).toEqual({
      value: "container:fresh",
      label: "New container",
    });
    expect(
      containerOptions(
        settings({
          runtime: { default: "podman", project: "podman", resolved: "podman" },
          runtimes: [unavailable("docker"), unavailable("podman")],
        }),
      )[0],
    ).toEqual({ value: "container:fresh", label: "New container" });
    expect(containerOptions(null)[0]).toEqual({ value: "container:fresh", label: "New container" });
  });

  it("shows activity instead of runtime, availability, raw status or id", () => {
    const options = containerOptions(
      settings({
        workspaces: [
          workspace({
            id: ContainerWorkspaceId.make("abcdefgh-one"),
            status: { type: "ready", destination },
            lastUsedAt: 2,
          }),
          workspace({
            id: ContainerWorkspaceId.make("ijklmnop-two"),
            checkoutPath: "/repo/other",
            runtime: "podman",
            lastUsedAt: 1,
          }),
        ],
        runtimes: [available("docker"), unavailable("podman")],
      }),
    );
    expect(options).toEqual([
      { value: "container:fresh", label: "New container" },
      { value: "container:abcdefgh-one", label: "t3code · Active" },
      { value: "container:ijklmnop-two", label: "other · Idle" },
    ]);
    for (const option of options.slice(1)) {
      expect(option.label).not.toContain("Docker");
      expect(option.label).not.toContain("Podman");
      expect(option.label).not.toContain("stopped");
      expect(option.label).not.toContain("abcdefgh");
      expect(option.label).not.toContain("ijklmnop");
    }
  });

  it("disambiguates duplicate checkout labels with the workspace id", () => {
    const options = containerOptions(
      settings({
        workspaces: [
          workspace({ id: ContainerWorkspaceId.make("abcdefgh-one"), lastUsedAt: 2 }),
          workspace({ id: ContainerWorkspaceId.make("ijklmnop-two"), lastUsedAt: 1 }),
        ],
      }),
    );
    expect(options.map((option) => option.label)).toEqual([
      "New container",
      "t3code · Idle · abcdefgh",
      "t3code · Idle · ijklmnop",
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
