export * from "@t3tools/shared/advertisedEndpoint";
import { containerRoutePrefix } from "../containers/endpoint.ts";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${containerRoutePrefix(httpBaseUrl)}${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
