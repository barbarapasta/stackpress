//client
import type { ProviderErrorKind } from '../types.js';

//OpenAI codes for a request the provider declined on policy grounds
const REFUSAL_CODES = [
  'content_filter',
  'content_policy_violation',
  'invalid_prompt'
];

//this is the one error the runtime catches from any adapter. It names the
// provider and the kind of failure, and keeps the SDK's own error as the cause.
// The message is the provider's own text, which never carries a request header.
export class ProviderError extends Error {
  public readonly kind: ProviderErrorKind;
  public readonly provider: string;
  public readonly status?: number;
  //seconds the provider asked the caller to wait, when it said
  public readonly retryAfter?: number;
  //the SDK's own error, kept for logs and debugging
  public cause?: unknown;

  public constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number, retryAfter?: number, cause?: unknown } = {}
  ) {
    super(message);
    this.cause = options.cause;
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

//this maps whatever an SDK threw to a ProviderError. Both official SDKs put
// the HTTP status on their error, so no SDK needs to be loaded to read it.
export function toProviderError(provider: string, error: unknown) {
  if (error instanceof ProviderError) {
    return error;
  }
  const source = error as {
    status?: unknown,
    code?: unknown,
    message?: unknown,
    headers?: unknown,
    error?: unknown
  } | null;
  const message = typeof source?.message === 'string' && source.message
    ? source.message
    : 'The provider request failed.';
  const status = typeof source?.status === 'number' ? source.status : undefined;
  const code = typeof source?.code === 'string' ? source.code : undefined;
  const options = { status, retryAfter: retryAfter(source?.headers), cause: error };
  if (status === 401) {
    return new ProviderError(provider, 'authentication', message, options);
  }
  if (status === 403) {
    //OpenRouter answers a moderation block with a 403 that lists its reasons
    return new ProviderError(
      provider,
      flagged(source?.error) ? 'refusal' : 'authentication',
      message,
      options
    );
  }
  if (status === 429) {
    //an exhausted quota will not clear by waiting, so it is not a rate limit
    return new ProviderError(
      provider,
      code === 'insufficient_quota' ? 'other' : 'rate_limit',
      message,
      options
    );
  }
  if (status === 400 && code && REFUSAL_CODES.includes(code)) {
    return new ProviderError(provider, 'refusal', message, options);
  }
  return new ProviderError(provider, 'other', message, options);
}

//this runs one provider call and rethrows any failure as a ProviderError
export async function guard<T>(provider: string, call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    throw toProviderError(provider, error);
  }
}

//the retry-after header is seconds, and the SDKs hand it over as Headers
function retryAfter(headers: unknown) {
  const value = headers instanceof Headers
    ? headers.get('retry-after')
    : null;
  const seconds = value ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

//OpenRouter puts moderation details under error.metadata.reasons
function flagged(body: unknown) {
  const metadata = (body as { metadata?: { reasons?: unknown } } | null)?.metadata;
  return Array.isArray(metadata?.reasons) && metadata.reasons.length > 0;
}
