import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Transformer from '@stackpress/idea-transformer/Transformer';
import type Model from '../../../stackpress-schema/src/Model.js';
import Schema from '../../../stackpress-schema/src/Schema.js';
import { makeCreateQuery } from '../../../stackpress-sql/src/transform/helpers.js';
import {
  createOAuthClient,
  createOAuthClientDocument,
  createOAuthPending,
  createOAuthGrant,
  createOAuthCode,
  createOAuthRefreshToken,
  createOAuthLegacyBinding,
  createOAuthFactorUse,
  createOAuthRateBucket,
  createOAuthClientCapacity
} from '../../src/oauth/storage/tables.js';

//Orchestrator-requested general drift guard (follow-up to task 00011):
//every defect 00011 found (the missing lockToken columns, the window vs
//window_start reserved-word mismatch, the MySQL-incompatible JSON
//defaults) existed because every prior task's own tests built tables via
//this file's *hand-written* `Create` builders, never via the real
//`oauth.idea` schema real apps actually generate from. This suite closes
//that gap permanently: it parses `oauth.idea` through the same real
//`@stackpress/idea-transformer`/`stackpress-schema`/`stackpress-sql`
//tooling `yarn generate` itself uses (`Transformer.schema()` ->
//`Schema.make()` -> `makeCreateQuery()`, the exact function
//`stackpress-sql/src/transform/store/create.ts` calls to emit each
//generated model's real `install()` body), and asserts the resulting
//column set and nullability match this file's hand-written builders
//column for column. A future edit to either side that adds, drops or
//renames a column - without updating the other - fails this suite.
//
//Relative filesystem imports into `stackpress-schema`'s and
//`stackpress-sql`'s private `src/` - the same cross-package, test-only
//pattern `stackpress-api/tests/oauth-legacy-real-store.test.ts` already
//established for real-store integration - not a package-specifier
//import, so neither package's `exports` map is touched by this test.

const here = path.dirname(fileURLToPath(import.meta.url));
const IDEA_PATH = path.join(here, '..', '..', 'oauth.idea');

type HandWrittenBuilder = () => { build(): ReturnType<ReturnType<typeof createOAuthClient>['build']> };

//Every one of storage.md's nine named models declared in `oauth.idea`,
//paired with its hand-written counterpart in `storage/tables.ts`.
//`OAuthClientCapacity` is deliberately absent here - it is not one of
//storage.md's nine models and is never declared in `oauth.idea` by
//design (see tables.ts's own comment); it gets its own expected-shape
//check below instead of a generated-vs-hand-written comparison.
const MODELS: Record<string, HandWrittenBuilder> = {
  OAuthClient: createOAuthClient,
  OAuthClientDocument: createOAuthClientDocument,
  OAuthPending: createOAuthPending,
  OAuthGrant: createOAuthGrant,
  OAuthCode: createOAuthCode,
  OAuthRefreshToken: createOAuthRefreshToken,
  OAuthLegacyBinding: createOAuthLegacyBinding,
  OAuthFactorUse: createOAuthFactorUse,
  OAuthRateBucket: createOAuthRateBucket
};

describe('oauth.idea generated schema matches storage/tables.ts (drift guard)', () => {
  let schema: Schema;

  before(async function () {
    this.timeout(30_000);
    const transformer = await Transformer.load<Record<string, unknown>>(IDEA_PATH);
    const config = await transformer.schema();
    schema = Schema.make(config);
  });

  for (const [ modelName, handWritten ] of Object.entries(MODELS)) {
    describe(modelName, () => {
      let model: Model | undefined;
      let generated: ReturnType<ReturnType<typeof createOAuthClient>['build']>;
      let handBuilt: ReturnType<ReturnType<typeof createOAuthClient>['build']>;

      before(() => {
        model = schema.models.get(modelName);
        if (!model) {
          throw new Error(
            `model ${modelName} is missing from oauth.idea (storage.md requires it)`
          );
        }
        generated = makeCreateQuery(model).build();
        handBuilt = handWritten().build();
      });

      it('generates the same table name as the hand-written builder', () => {
        expect(generated.table).to.equal(handBuilt.table);
      });

      it('has no column the hand-written builder lacks, and vice versa', () => {
        const generatedFields = Object.keys(generated.fields).sort();
        const handFields = Object.keys(handBuilt.fields).sort();
        expect(generatedFields).to.deep.equal(handFields);
      });

      it('matches nullability for every shared column', () => {
        for (const field of Object.keys(handBuilt.fields)) {
          const generatedField = generated.fields[field];
          const handField = handBuilt.fields[field];
          expect(
            generatedField,
            `generated schema is missing column "${field}"`
          ).to.exist;
          expect(
            !!generatedField.nullable,
            `column "${field}" nullable mismatch (generated: ${generatedField.nullable}, hand-written: ${handField.nullable})`
          ).to.equal(!!handField.nullable);
        }
      });

      it('declares the same single-column primary key', () => {
        expect(generated.primary).to.deep.equal(handBuilt.primary);
      });
    });
  }

  it('the self-bootstrapped oauth_client_capacity table (not part of oauth.idea by design) keeps its expected shape', () => {
    //No generated counterpart exists for this table - it holds no
    //identity/credential/approval data and is created directly by
    //OAuthStore.ts's `_ensureCapacityTable()`, never via code generation.
    //This records its expected column set so a future edit to this one
    //hand-written builder cannot silently drop a column
    //`reserveClientCapacity`/`releaseClientCapacity` depend on.
    const built = createOAuthClientCapacity().build();
    expect(built.table).to.equal('oauth_client_capacity');
    expect(Object.keys(built.fields).sort()).to.deep.equal(
      [ 'count', 'id', 'lock_token' ]
    );
    expect(built.fields.id.nullable).to.not.equal(true);
    expect(built.fields.count.nullable).to.not.equal(true);
    expect(built.fields.lock_token.nullable).to.equal(true);
    expect(built.primary).to.deep.equal([ 'id' ]);
  });
});
