import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ContainerSettingsPanel } from "../features/containers/ContainerSettings";
import { useClientSettings } from "../hooks/useSettings";

function ContainerSettingsRoute() {
  const containersEnabled = useClientSettings((settings) => settings.containersEnabled);
  if (!containersEnabled) return <Navigate to="/settings/general" replace />;
  return <ContainerSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/containers")({
  component: ContainerSettingsRoute,
});
