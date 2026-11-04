import { containerGatewayPath, type ContainerWorkspaceId } from "@t3tools/contracts";

export function containerRoutePrefix(httpBaseUrl: string): string {
  const path = new URL(httpBaseUrl).pathname;
  return /^\/api\/container-gateway\/[a-zA-Z0-9-]{1,80}\/?$/.test(path)
    ? path.replace(/\/$/, "")
    : "";
}

export function containerHttpBaseUrl(
  hostBaseUrl: string,
  workspaceId: ContainerWorkspaceId,
): string {
  const url = new URL(hostBaseUrl);
  url.pathname = `${containerGatewayPath(workspaceId)}/`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function containerResourceUrl(httpBaseUrl: string, resource: string): string | null {
  const prefix = containerRoutePrefix(httpBaseUrl);
  const url = new URL(resource, httpBaseUrl);
  if (!prefix) return url.href;
  if (url.origin !== new URL(httpBaseUrl).origin) return null;
  if (!url.pathname.startsWith(`${prefix}/`)) url.pathname = `${prefix}${url.pathname}`;
  return url.href;
}
