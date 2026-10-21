import { describe, it } from 'mocha';
import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IDEA_PATH = path.join(here, '..', '..', 'oauth.idea');
const source = fs.readFileSync(IDEA_PATH, 'utf8');

//Task 00011 found that `oauth.idea` (the schema the real generated
//production store/migration path actually uses) had silently drifted
//from the hand-written `storage/tables.ts`/`OAuthStore.ts` it is meant
//to match, because every prior task's own tests always created tables
//via `createAllOAuthTables()` (tables.ts), never via a real `yarn
//generate`+`yarn push` of `oauth.idea` itself. Three distinct real
//production defects only surfaced once templates/blog's actual
//generated+pushed database was exercised: a reserved-word column name,
//missing CAS-lock columns, and MySQL-incompatible JSON column defaults.
//These checks read the real `oauth.idea` source directly (no code
//generation dependency) so a future edit cannot silently reintroduce any
//of the three.
describe('oauth.idea generation pitfalls (task 00011 production findings)', () => {
  it('does not declare a bare "window" field (SQL reserved word in MySQL 8.0.2+ and the SQL standard)', () => {
    //a field declaration line looks like `  window  Datetime` at the
    //start of a line (two or more spaces of indentation, the exact word,
    //then whitespace and a type) - matches only a field named exactly
    //"window", not "windowStart" or anything else containing it.
    const bareWindowField = /^\s{2,}window\s+\w/m;
    expect(bareWindowField.test(source)).to.equal(false);
  });

  it('OAuthRateBucket declares windowStart (generates window_start, matching storage/tables.ts and OAuthStore.ts)', () => {
    const model = extractModel('OAuthRateBucket');
    expect(model).to.match(/^\s{2,}windowStart\s+Datetime/m);
  });

  for (const model of [ 'OAuthPending', 'OAuthGrant', 'OAuthFactorUse', 'OAuthRateBucket' ]) {
    it(`${model} declares lockToken (OAuthStore.ts's _claim() CAS helper requires a lock_token column on every table it locks)`, () => {
      const body = extractModel(model);
      expect(body).to.match(/^\s{2,}lockToken\s+String\?/m);
    });
  }

  it('declares no @default([]) or @default({}) anywhere: real MySQL rejects any DEFAULT on a JSON/TEXT/BLOB column, and OAuthStore.ts always supplies these fields explicitly on insert', () => {
    expect(source).to.not.include('@default([])');
    expect(source).to.not.include('@default({})');
  });

  function extractModel(name: string): string {
    const match = source.match(new RegExp(`model ${name}\\b[\\s\\S]*?\\n\\}`));
    if (!match) {
      throw new Error(`model ${name} not found in oauth.idea`);
    }
    return match[0];
  }
});
