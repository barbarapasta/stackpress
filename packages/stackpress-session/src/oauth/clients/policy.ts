//One allowed-client policy shared by both client-introduction methods
//(a registered dynamic client and a client-document URL identity),
//per configuration.md's `clients.allowed` and task 00004's instruction
//to apply a single policy function to both. Registration itself never
//calls this (events.md: "Registration creates no grant...an unlisted
//dynamically registered ID receives no user access" - the check
//matters at *use*, not at the moment a client ID is minted); the
//client-document path calls it before spending a network fetch on a
//client ID that could never be approved anyway.

import type { OAuthClientsConfig } from '../types.js';

/**
 * `clients.allowed` omitted: any validated compatible client may
 * request approval. `clients.allowed` present (including an explicitly
 * empty list): only an exact listed `clientId` is admitted; an empty
 * list denies every client ID. Equality is exact string match - no
 * prefix, case-fold or URL-normalization leniency, since an allowed
 * list may legitimately contain a document URL that differs only by a
 * trailing slash from an unrelated service.
 */
export function isClientAllowed(
  clientId: string,
  clients: OAuthClientsConfig | undefined
): boolean {
  if (!clients || typeof clients.allowed === 'undefined') {
    return true;
  }
  return clients.allowed.includes(clientId);
}
