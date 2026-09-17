/**
 * A minimal disposal registry for resources that live outside the
 * `vscode.ExtensionContext.subscriptions` model (e.g. a reassignable
 * platform connection held in a closure). `deactivate()` has no access to
 * `activate()`'s local variables, so anything it must clean up on extension
 * shutdown needs to be registered here instead.
 */
export interface Disposable {
  dispose(): void;
}

export interface DisposableRegistry {
  register(d: Disposable): void;
  disposeAll(): void;
}

export function createDisposableRegistry(): DisposableRegistry {
  const disposables: Disposable[] = [];
  return {
    register(d: Disposable): void {
      disposables.push(d);
    },
    disposeAll(): void {
      while (disposables.length > 0) {
        const d = disposables.pop();
        try {
          d?.dispose();
        } catch {
          // Best-effort cleanup during deactivation — one failing dispose()
          // must not prevent the rest from running.
        }
      }
    }
  };
}
