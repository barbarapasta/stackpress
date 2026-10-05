//node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import * as entry from '../src/client/index.js';
import AgentPanel from '../src/client/AgentPanel.js';

//The `client` entry is loaded by the browser. It must reach nothing that
// only runs on a server: no Node module, no server file of this package, no
// package that is not React or the translation library. Type imports are
// erased, so they may name the package's type file.

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.join(here, '..', 'src', 'client');
const files = readdirSync(folder).filter(file => /\.tsx?$/.test(file));

//what an import line names, and whether it is a type import
function imports(source: string) {
  const found: { from: string, type: boolean }[] = [];
  const pattern = /(?:^|\n)\s*(import|export)(\s+type)?\s*(?:[^'"\n;]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    found.push({ from: match[3], type: Boolean(match[2]) });
  }
  return found;
}

describe('the browser entry', () => {
  it('has files to check', () => {
    expect(files).to.include.members([ 'index.ts', 'AgentPanel.tsx', 'controller.ts', 'api.ts' ]);
  });

  for (const file of files) {
    it(`${file} imports only React, r22n and the browser files of its own folder`, () => {
      const source = readFileSync(path.join(folder, file), 'utf8');
      for (const { from, type } of imports(source)) {
        if (type) {
          //erased when compiled: it may name the package's types
          expect(from, `${file} type import`).to.match(/^(\.\.?\/|react$)/);
          continue;
        }
        const ok = from === 'react' || from === 'r22n' || from === 'react/jsx-runtime'
          || (/^\.\//.test(from) && !from.includes('..'));
        expect(ok, `${file} imports ${from}`).to.equal(true);
      }
    });
  }

  it('reads imports the way it claims to', () => {
    const found = imports(
      "import type { A } from '../types.js';\nimport { b } from './b.js';\n"
      + "export type { C } from './types.js';\nexport { d } from 'r22n';\n"
      + "import x from 'node:fs';\n"
    );
    expect(found).to.deep.equal([
      { from: '../types.js', type: true },
      { from: './b.js', type: false },
      { from: './types.js', type: true },
      { from: 'r22n', type: false },
      { from: 'node:fs', type: false }
    ]);
  });

  it('exports the panel, the logic under it, and the panel as its default', () => {
    expect(entry.default).to.equal(AgentPanel);
    expect(entry.AgentPanel).to.equal(AgentPanel);
    for (const name of [
      'PanelView', 'ActionCard', 'createClient', 'parseEvents', 'reasonOf',
      'chips', 'createPanel', 'wire', 'addUser', 'applyEvent',
      'emptyConversation', 'fromThread', 'syncActions', 'toolLabel', 'usePanel'
    ]) {
      expect(typeof (entry as Record<string, unknown>)[name], name).to.equal('function');
    }
    //nothing from the server side of the package is among them
    expect(Object.keys(entry)).to.not.include.members([ 'createRuntime', 'runTurn', 'createStore' ]);
  });

  it('is exported by the package manifest as `client`, with its styles and its types', () => {
    const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    expect(manifest.exports['./client']).to.deep.equal({
      require: './cjs/client/index.js',
      import: './esm/client/index.js'
    });
    expect(manifest.exports['./styles.css']).to.equal('./styles.css');
    expect(manifest.files).to.include('styles.css');
    expect(manifest.typesVersions['*'].client).to.deep.equal([ './cjs/client/index.d.ts' ]);
  });
});
