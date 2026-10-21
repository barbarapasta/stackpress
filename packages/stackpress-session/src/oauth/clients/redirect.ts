//Return-address ("redirect_uri") validation (configuration.md/
//storage.md/verification.md "Return addresses"). Every component must
//match a registered redirect exactly - scheme, host, path, query - with
//exactly one accepted relaxation: an explicitly registered local-machine
//host (localhost, 127.0.0.1 or ::1, each a separate identity) may be
//presented back with a different port, for native clients that listen
//on an ephemeral loopback port chosen at launch time. No other
//difference is ever accepted, including a trailing slash, a fragment, or
//embedded credentials.

const LOCAL_MACHINE_HOSTS = new Set([ 'localhost', '127.0.0.1', '::1' ]);

/**
 * True only for the three exact local-machine host spellings this
 * contract recognizes. Each is a distinct identity: a redirect
 * registered on "localhost" never matches a candidate on "127.0.0.1" or
 * "::1", even at the same port and path.
 */
export function isLocalMachineHost(hostname: string): boolean {
  return LOCAL_MACHINE_HOSTS.has(hostname);
}

function parseExact(value: string): URL | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  //a return address can never carry a fragment, and never carries
  //caller credentials.
  if (url.hash || url.username || url.password) {
    return null;
  }
  return url;
}

/**
 * True when `candidate` exactly matches one entry in `registered`,
 * applying only the local-machine port relaxation above. Every other
 * difference - scheme, host, path, query, a deceptive hostname that
 * merely contains the word "localhost", or a fragment - is rejected.
 * Never falls back to treating an unchecked candidate as the "current"
 * address: a registration list is required and an empty one accepts
 * nothing.
 */
export function validateReturnAddress(
  candidate: string,
  registered: string[]
): boolean {
  const candidateUrl = parseExact(candidate);
  if (!candidateUrl) {
    return false;
  }
  for (const entry of registered) {
    const registeredUrl = parseExact(entry);
    if (!registeredUrl) {
      continue;
    }
    if (
      registeredUrl.protocol !== candidateUrl.protocol ||
      registeredUrl.hostname !== candidateUrl.hostname ||
      registeredUrl.pathname !== candidateUrl.pathname ||
      registeredUrl.search !== candidateUrl.search
    ) {
      continue;
    }
    if (registeredUrl.port === candidateUrl.port) {
      return true;
    }
    //port differs: only acceptable when the registered entry itself
    //names an explicit local-machine host. A deceptive hostname such as
    //"localhost.evil.example" is a different exact `hostname` and was
    //already rejected by the equality check above.
    if (isLocalMachineHost(registeredUrl.hostname)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a client-declared/registered redirect URI at registration
 * time: must be an absolute URL with no fragment or credentials, and
 * HTTPS unless it is an explicit local-machine host (native loopback
 * clients are always permitted regardless of `development`, since they
 * never leave the user's own machine).
 */
export function isAcceptableRegisteredRedirect(value: string): boolean {
  const url = parseExact(value);
  if (!url) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  if (url.protocol === 'http:' && isLocalMachineHost(url.hostname)) {
    return true;
  }
  return false;
}
