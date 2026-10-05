//node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import * as root from '../src/index.js';
import * as adapters from '../src/adapters/index.js';
import * as events from '../src/events/index.js';
import * as scripts from '../src/scripts/index.js';

//The public surface is decided in one place. This pins it: the manifest, the
// source files it points at, and the names each entry exports. A change to the
// surface has to change this file too.

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, '..');
const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
const exported = Object.entries(manifest.exports) as [ string, any ][];
const paths = exported.filter(([ , target ]) => typeof target === 'object');

describe('the package manifest', () => {
  it('exports exactly the promised paths', () => {
    expect(Object.keys(manifest.exports)).to.have.members([
      '.',
      './adapters',
      './client',
      './events',
      './events/index',
      './events/http',
      './events/sse',
      './events/stdio',
      './helpers',
      './plugin',
      './scripts',
      './scripts/index',
      './scripts/http',
      './scripts/sse',
      './scripts/stdio',
      './styles.css',
      './transform',
      './types'
    ]);
  });

  it('has no wildcard path that would expose a file by accident', () => {
    for (const [ key ] of exported) expect(key).to.not.include('*');
  });

  it('points every path at a source file in both builds', () => {
    for (const [ key, target ] of paths) {
      const cjs = (target.require as string).match(/^\.\/cjs\/(.+)\.js$/);
      const esm = (target.import as string).match(/^\.\/esm\/(.+)\.js$/);
      expect(cjs, `${key} require`).to.not.equal(null);
      expect(esm, `${key} import`).to.not.equal(null);
      expect(esm![1], key).to.equal(cjs![1]);
      const source = ['.ts', '.tsx'].some(ext =>
        existsSync(path.join(base, 'src', `${cjs![1]}${ext}`))
      );
      expect(source, `src/${cjs![1]} for ${key}`).to.equal(true);
    }
  });

  it('declares a type file for each path that matches the exported one', () => {
    const types = manifest.typesVersions['*'] as Record<string, string[]>;
    const code = paths.map(([ key ]) => key === '.' ? '.' : key.slice(2));
    expect(Object.keys(types)).to.have.members(code);
    for (const [ key, target ] of paths) {
      const name = key === '.' ? '.' : key.slice(2);
      expect(types[name], key).to.deep.equal([
        (target.require as string).replace(/\.js$/, '.d.ts')
      ]);
    }
  });

  it('lists the files that must ship and none that must not', () => {
    expect(manifest.files).to.have.members([
      'cjs', 'esm', 'LICENSE', 'README.md', 'schema.idea', 'styles.css'
    ]);
    for (const file of manifest.files.filter((f: string) => !/^(cjs|esm)$/.test(f))) {
      expect(existsSync(path.join(base, file)), file).to.equal(true);
    }
    expect(manifest.exports['./styles.css']).to.equal('./styles.css');
  });

  it('keeps the provider SDKs, react and ts-morph optional', () => {
    for (const name of [ '@anthropic-ai/sdk', 'openai', 'react', 'ts-morph' ]) {
      expect(manifest.peerDependencies, name).to.have.property(name);
      expect(manifest.peerDependenciesMeta[name], name).to.deep.equal({ optional: true });
      expect(manifest.dependencies, name).to.not.have.property(name);
    }
  });
});

describe('the package root', () => {
  it('exports only the server side API of an app developer', () => {
    expect(Object.keys(root)).to.have.members([
      'AGENT_EVENTS',
      'CONTEXT_EVENT',
      'caller',
      'contributeTool',
      'createMcpServer',
      'createRuntime',
      'createStore',
      'default',
      'undoing',
      'watch'
    ]);
  });

  it('keeps the lower level workflow behind the scripts subpath', () => {
    for (const name of [ 'runTurn', 'approve', 'decline', 'undo', 'listThreads', 'loadThread' ]) {
      expect(root).to.not.have.property(name);
      expect(scripts).to.have.property(name).that.is.a('function');
    }
  });
});

describe('the subpath barrels', () => {
  it('keeps the transports exported from scripts and events as before', () => {
    for (const name of [ 'http', 'sse', 'stdio' ]) {
      expect(scripts, `scripts ${name}`).to.have.property(name).that.is.a('function');
      expect(events, `events ${name}`).to.have.property(name).that.is.a('function');
    }
  });

  it('exports named things from scripts and no internal helper', () => {
    expect(Object.keys(scripts)).to.have.members([
      'http', 'sse', 'stdio',
      'TOOLS_EVENT', 'callTool', 'caller', 'collectTools', 'contributeTool',
      'failed', 'loadRegistry', 'undoing',
      'createRuntime', 'watch', 'createStore',
      'runTurn', 'approve', 'decline', 'undo', 'listThreads', 'loadThread'
    ]);
  });

  it('exports the event listeners and names from events and no helper', () => {
    expect(Object.keys(events)).to.have.members([
      'http', 'sse', 'stdio',
      'turn', 'approve', 'decline', 'undo', 'threads', 'thread', 'start',
      'create', 'AGENT_EVENTS', 'CONTEXT_EVENT'
    ]);
  });

  it('exports the adapter chooser and the provider error', () => {
    expect(Object.keys(adapters)).to.have.members([
      'ProviderError', 'createAdapter', 'default', 'loaders', 'toProviderError'
    ]);
    expect(adapters.default).to.equal(adapters.createAdapter);
  });
});
