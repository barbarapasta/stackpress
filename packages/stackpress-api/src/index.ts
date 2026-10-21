export type {
  ApiType,
  ApiConfigProps,
  ApiOauthInputProps,
  ApiOauthFormProps,
  Scopes,
  ApiEndpoint,
  ApiScope,
  ApiWebhook,
  ApiConfig,
  Application,
  ApplicationExtended,
  ApplicationInput,
  Session,
  SessionExtended,
  SessionInput
} from './types.js';

export type {
  LegacyMcpKind,
  LegacyMcpIdentity
} from './legacy.js';

export type {
  LegacyMigrationKind,
  LegacyMigrationInput,
  LegacyMigrationRecordStatus,
  LegacyMigrationRecordResult,
  LegacyMigrationResult
} from './migrate.js';

import StackpressApiException from './Exception.js';
import { verifyLegacyMcpKey } from './legacy.js';

export { StackpressApiException, verifyLegacyMcpKey };