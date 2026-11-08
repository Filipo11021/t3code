import type { AssetCreateUrlResult } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

export function withContainerAssetRefresh<E>(
  self: Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, E>>,
) {
  return Atom.transform(
    self,
    (get) => {
      const result = get(self);
      if (
        result._tag === "Success" &&
        result.value.relativeUrl.startsWith("/api/container-gateway/") &&
        result.value.relativeUrl.includes("wsTicket=")
      ) {
        // @effect-diagnostics-next-line globalTimers:off -- Media elements need a fresh host ticket while mounted.
        const handle = setTimeout(() => get.refresh(self), 4 * 60_000);
        get.addFinalizer(() => clearTimeout(handle));
      }
      return result;
    },
    { initialValueTarget: self },
  );
}
