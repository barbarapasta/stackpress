//Direct coverage for the existing (previously untested) auth column
//classes' required-field assert branch and the Date/object/number
//serialize-unserialize branches that AuthActions' everyday string-token
//flows never reach. Part of side task 00007A.
import { describe, it } from 'mocha';
import { expect } from 'chai';
import IdColumn from '../../src/auth/columns/IdColumn.js';
import ProfileIdColumn from '../../src/auth/columns/ProfileIdColumn.js';
import TypeColumn from '../../src/auth/columns/TypeColumn.js';
import TokenColumn from '../../src/auth/columns/TokenColumn.js';
import SecretColumn from '../../src/auth/columns/SecretColumn.js';
import VerifiedColumn from '../../src/auth/columns/VerifiedColumn.js';
import ConsumedColumn from '../../src/auth/columns/ConsumedColumn.js';
import ActiveColumn from '../../src/auth/columns/ActiveColumn.js';
import CreatedColumn from '../../src/auth/columns/CreatedColumn.js';
import UpdatedColumn from '../../src/auth/columns/UpdatedColumn.js';

describe('auth columns', () => {
  describe('string-shaped columns (id/profileId/type/token/secret)', () => {
    const columns = [
      new IdColumn(), new ProfileIdColumn(), new TypeColumn(),
      new TokenColumn('seed'), new SecretColumn()
    ];

    for (const column of columns) {
      describe(column.name, () => {
        it('assert(undefined) reports the required-field error', () => {
          expect(column.assert(undefined)).to.be.a('string');
        });

        it('assert(valid) returns null', () => {
          expect(column.assert('a-valid-value-12345')).to.equal(null);
        });

        it('serialize(undefined) stays undefined; unserialize(undefined) stays undefined', () => {
          expect(column.serialize(undefined)).to.equal(undefined);
          expect(column.unserialize(undefined)).to.equal(undefined);
        });

        it('serialize/unserialize a Date value takes the date-formatting branch', () => {
          const date = new Date('2026-01-02T03:04:05.000Z');
          expect(column.serialize(date)).to.be.a('string');
          expect(column.unserialize(date)).to.be.a('string');
        });

        it('serialize/unserialize a plain object takes the JSON-stringify branch', () => {
          const object = { a: 1 };
          expect(column.serialize(object)).to.equal(JSON.stringify(object));
          expect(column.unserialize(object)).to.equal(JSON.stringify(object));
        });

        it('serialize/unserialize a plain string round-trips', () => {
          expect(column.serialize('plain-value')).to.be.a('string');
          expect(column.unserialize('plain-value')).to.equal('plain-value');
        });
      });
    }
  });

  describe('boolean-shaped columns (verified/active)', () => {
    const columns = [ new VerifiedColumn(), new ActiveColumn() ];

    for (const column of columns) {
      describe(column.name, () => {
        it('assert(undefined) reports the required-field error', () => {
          expect(column.assert(undefined)).to.be.a('string');
        });

        it('assert(true/false) both return null', () => {
          expect(column.assert(true)).to.equal(null);
          expect(column.assert(false)).to.equal(null);
        });

        it('defaults is a boolean', () => {
          expect(column.defaults).to.be.a('boolean');
        });

        it('serialize/unserialize round-trip true and false', () => {
          expect(column.unserialize(column.serialize(true))).to.equal(true);
          expect(column.unserialize(column.serialize(false))).to.equal(false);
        });
      });
    }
  });

  describe('date-shaped columns (consumed/created/updated)', () => {
    const columns = [ new ConsumedColumn(), new CreatedColumn(), new UpdatedColumn() ];

    for (const column of columns) {
      describe(column.name, () => {
        it('assert(undefined) reports the required-field error', () => {
          expect(column.assert(undefined)).to.be.a('string');
        });

        it('assert(a real date) returns null; assert(an unparsable date) reports an error', () => {
          expect(column.assert(new Date())).to.equal(null);
          expect(column.assert(new Date('not-a-real-date'))).to.be.a('string');
        });

        it('defaults is a Date', () => {
          expect(column.defaults).to.be.instanceOf(Date);
        });

        it('serialize/unserialize accepts a Date, a number and a string timestamp', () => {
          const date = new Date('2026-01-02T03:04:05.000Z');
          expect(column.serialize(date)).to.be.a('string');
          expect(column.serialize(date.getTime())).to.be.a('string');
          expect(column.serialize('2026-01-02T03:04:05.000Z')).to.be.a('string');
          expect(column.unserialize(date)).to.be.instanceOf(Date);
          expect(column.unserialize(date.getTime())).to.be.instanceOf(Date);
          expect(column.unserialize('2026-01-02T03:04:05.000Z')).to.be.instanceOf(Date);
        });

        it('serialize/unserialize falls back to the epoch for an unparsable string', () => {
          expect(column.unserialize('not-a-real-date')).to.deep.equal(new Date(0));
        });
      });
    }
  });
});
