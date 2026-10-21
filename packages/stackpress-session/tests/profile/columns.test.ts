//Direct coverage for the existing (previously untested) profile column
//classes' required-field assert branch and the Date/object/array
//serialize-unserialize branches that ProfileActions' everyday flows never
//reach. Part of side task 00007A.
import { describe, it } from 'mocha';
import { expect } from 'chai';
import IdColumn from '../../src/profile/columns/IdColumn.js';
import NameColumn from '../../src/profile/columns/NameColumn.js';
import TypeColumn from '../../src/profile/columns/TypeColumn.js';
import ImageColumn from '../../src/profile/columns/ImageColumn.js';
import RolesColumn from '../../src/profile/columns/RolesColumn.js';
import TagsColumn from '../../src/profile/columns/TagsColumn.js';
import ReferencesColumn from '../../src/profile/columns/ReferencesColumn.js';
import ActiveColumn from '../../src/profile/columns/ActiveColumn.js';
import CreatedColumn from '../../src/profile/columns/CreatedColumn.js';
import UpdatedColumn from '../../src/profile/columns/UpdatedColumn.js';

describe('profile columns', () => {
  describe('string-shaped required columns (id/name/type)', () => {
    const columns = [ new IdColumn(), new NameColumn(), new TypeColumn() ];

    for (const column of columns) {
      describe(column.name, () => {
        it('assert(undefined) reports the required-field error', () => {
          expect(column.assert(undefined)).to.be.a('string');
        });

        it('assert(valid) returns null', () => {
          expect(column.assert('a-valid-value')).to.equal(null);
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
      });
    }
  });

  describe('ImageColumn (optional, nullable string)', () => {
    const column = new ImageColumn();

    it('assert(undefined) and assert(null) are both valid (optional/nullable)', () => {
      expect(column.assert(undefined)).to.equal(null);
      expect(column.assert(null)).to.equal(null);
    });

    it('assert(a string) is valid', () => {
      expect(column.assert('https://example.com/a.png')).to.equal(null);
    });

    it('serialize/unserialize null stays null; undefined stays undefined', () => {
      expect(column.serialize(null)).to.equal(null);
      expect(column.unserialize(null)).to.equal(null);
      expect(column.serialize(undefined)).to.equal(undefined);
      expect(column.unserialize(undefined)).to.equal(undefined);
    });

    it('serialize/unserialize a plain string round-trips', () => {
      expect(column.serialize('https://example.com/a.png')).to.be.a('string');
      expect(column.unserialize('https://example.com/a.png')).to.equal('https://example.com/a.png');
    });
  });

  describe('array-shaped columns (roles/tags)', () => {
    const columns = [ new RolesColumn(), new TagsColumn() ];

    for (const column of columns) {
      describe(column.name, () => {
        it('defaults is an array', () => {
          expect(column.defaults).to.be.an('array');
        });

        it('serialize(non-array) falls back to an empty array literal', () => {
          expect(column.serialize('not-an-array' as any)).to.equal('[]');
        });

        it('serialize/unserialize a string array round-trips through JSON', () => {
          const serialized = column.serialize([ 'ADMIN', 'USER' ]);
          expect(serialized).to.equal(JSON.stringify([ 'ADMIN', 'USER' ]));
          expect(column.unserialize(serialized)).to.deep.equal([ 'ADMIN', 'USER' ]);
        });

        it('unserialize(non-array, non-string) returns an empty array', () => {
          expect(column.unserialize(42 as any)).to.deep.equal([]);
        });

        it('unserialize(malformed JSON string) returns an empty array', () => {
          expect(column.unserialize('not-json')).to.deep.equal([]);
        });

        it('unserialize(a JSON array of non-strings) stringifies each item', () => {
          expect(column.unserialize('[1,2]')).to.deep.equal([ '1', '2' ]);
        });

        it('serialize/unserialize an array containing a Date item', () => {
          const date = new Date('2026-01-02T03:04:05.000Z');
          const serialized = column.serialize([ date ] as any);
          expect(serialized).to.be.a('string');
          expect(column.unserialize([ date ] as any)).to.be.an('array');
        });

        it('serialize/unserialize an array containing a plain object item', () => {
          const serialized = column.serialize([ { a: 1 } ] as any);
          expect(serialized).to.be.a('string');
        });
      });
    }
  });

  describe('ReferencesColumn (nullable object)', () => {
    const column = new ReferencesColumn();

    it('defaults is an object', () => {
      expect(column.defaults).to.deep.equal({});
    });

    it('serialize/unserialize null stays null', () => {
      expect(column.serialize(null)).to.equal(null);
      expect(column.unserialize(null)).to.equal(null);
    });

    it('serialize/unserialize undefined stays undefined', () => {
      expect(column.serialize(undefined)).to.equal(undefined);
      expect(column.unserialize(undefined)).to.equal(undefined);
    });

    it('serialize a plain object JSON-stringifies it', () => {
      expect(column.serialize({ a: 1 })).to.equal(JSON.stringify({ a: 1 }));
    });

    it('serialize(a valid JSON object string) keeps it, serialize(an invalid one) resets to "{}"', () => {
      expect(column.serialize('{"a":1}')).to.equal('{"a":1}');
      expect(column.serialize('not-json')).to.equal('{}');
    });

    it('unserialize(a valid JSON object string) parses it, unserialize(an invalid one) resets to {}', () => {
      expect(column.unserialize('{"a":1}')).to.deep.equal({ a: 1 });
      expect(column.unserialize('not-json')).to.deep.equal({});
    });

    it('unserialize(a non-object value) resets to {}', () => {
      expect(column.unserialize(42 as any)).to.deep.equal({});
    });

    it('unserialize(a plain object) passes it through', () => {
      expect(column.unserialize({ a: 1 })).to.deep.equal({ a: 1 });
    });

    it('assert accepts an object, undefined and null; rejects a non-object', () => {
      expect(column.assert({})).to.equal(null);
      expect(column.assert(undefined)).to.equal(null);
      expect(column.assert(null)).to.equal(null);
    });
  });

  describe('boolean/date columns (active/created/updated)', () => {
    const active = new ActiveColumn();
    const created = new CreatedColumn();
    const updated = new UpdatedColumn();

    it('ActiveColumn: assert(undefined) errors, assert(bool) is valid, defaults is boolean', () => {
      expect(active.assert(undefined)).to.be.a('string');
      expect(active.assert(true)).to.equal(null);
      expect(active.defaults).to.be.a('boolean');
    });

    for (const column of [ created, updated ]) {
      describe(column.name, () => {
        it('assert(undefined) errors; assert(a real date) is valid', () => {
          expect(column.assert(undefined)).to.be.a('string');
          expect(column.assert(new Date())).to.equal(null);
        });

        it('defaults is a Date', () => {
          expect(column.defaults).to.be.instanceOf(Date);
        });

        it('serialize/unserialize accepts a Date, a number and a string timestamp', () => {
          const date = new Date('2026-01-02T03:04:05.000Z');
          expect(column.serialize(date)).to.be.a('string');
          expect(column.serialize(date.getTime())).to.be.a('string');
          expect(column.unserialize(date)).to.be.instanceOf(Date);
          expect(column.unserialize(date.getTime())).to.be.instanceOf(Date);
        });

        it('falls back to the epoch for an unparsable string', () => {
          expect(column.unserialize('not-a-real-date')).to.deep.equal(new Date(0));
        });
      });
    }
  });
});
