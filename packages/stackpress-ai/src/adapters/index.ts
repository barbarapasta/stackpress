//client
import type { Adapter, AdapterConfig } from '../types.js';
import { ProviderError } from './errors.js';

//each loader imports its adapter module only when it is called, so an app
// installs and loads only the SDK of the provider it chose
export const loaders = {
  anthropic: () => import('./anthropic.js'),
  openai: () => import('./openai.js'),
  openrouter: () => import('./openrouter.js'),
  stub: () => import('./stub.js')
};

//the package each provider module needs, named in the error when it is missing
const PACKAGES: Record<string, string> = {
  anthropic: '@anthropic-ai/sdk',
  openai: 'openai',
  openrouter: 'openai'
};

/**
 * Choose the adapter the config names and load its module.
 */
export async function createAdapter(
  config: AdapterConfig,
  load: typeof loaders = loaders
): Promise<Adapter> {
  const { provider, ...options } = config;
  if (!Object.prototype.hasOwnProperty.call(load, provider)) {
    throw new ProviderError(
      String(provider),
      'other',
      `Unknown model provider "${provider}". `
        + `Use one of: ${Object.keys(loaders).join(', ')}.`
    );
  }
  let module;
  try {
    module = await load[provider]();
  } catch (error) {
    const pkg = PACKAGES[provider];
    if (pkg && (error as { code?: string }).code?.endsWith('MODULE_NOT_FOUND')) {
      throw new ProviderError(
        provider,
        'other',
        `The "${provider}" provider needs the "${pkg}" package. `
          + `Install it with: npm install ${pkg}`,
        { cause: error }
      );
    }
    throw error;
  }
  //the loaders return different option shapes, which the config type matches
  return (module.default as (options: unknown) => Adapter)(options);
}

export { ProviderError, toProviderError } from './errors.js';
export default createAdapter;
