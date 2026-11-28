import type { RpcClient } from "./rpc";
import type { SaveScope } from "./query";
import { useSave } from "./query";

/** Run a managed JSON write (and its reconciliation) in the space selected at submission. */
export function useManagedOperation<Saved = void>() {
  return useSave<(scope: SaveScope, client: RpcClient) => Promise<Saved>, Saved>({
    rememberInput: false,
    saveScoped: (operation, client, scope) => operation(scope, client),
  });
}
