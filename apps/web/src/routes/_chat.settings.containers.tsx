import { createFileRoute } from "@tanstack/react-router";
import { ContainerSettingsPanel } from "../features/containers/ContainerSettings";

export const Route = createFileRoute("/_chat/settings/containers")({
  component: ContainerSettingsPanel,
});
