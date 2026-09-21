import { CredentialReference, CredentialResolver } from './types';

/**
 * The extension point: a production deployment (or a test) registers its own
 * `CredentialResolver` — an enterprise secrets manager, a fake for a unit test —
 * without touching `ConnectionManager` or any adapter.
 */
const resolvers = new Map<string, CredentialResolver>();

export function registerCredentialResolver(resolver: CredentialResolver): void {
  resolvers.set(resolver.id, resolver);
}

export function unregisterCredentialResolver(id: string): void {
  resolvers.delete(id);
}

export function getCredentialResolver(id: string): CredentialResolver | undefined {
  return resolvers.get(id);
}

export function listCredentialResolvers(): CredentialResolver[] {
  return Array.from(resolvers.values());
}

/**
 * Resolves a `CredentialReference` to an actual credential set via whichever
 * resolver it names. Returns `undefined` (never throws) if that resolver isn't
 * registered or can't resolve the reference — same "data, not exceptions" contract
 * every resolver's own `resolve()` follows.
 */
export async function resolveCredential(reference: CredentialReference): Promise<Record<string, string> | undefined> {
  const resolver = resolvers.get(reference.resolverId);
  if (!resolver) {
    return undefined;
  }
  return resolver.resolve(reference);
}
