//node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
import ts from 'typescript';
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

//this is the part of package.json that these tests read
type Target = { require: string, import: string };
type Manifest = {
  exports: Record<string, string | Target>,
  typesVersions: Record<string, Record<string, string[]>>,
  files: string[],
  dependencies: Record<string, string>,
  peerDependencies: Record<string, string>,
  peerDependenciesMeta: Record<string, { optional?: boolean }>
};

const manifest = JSON.parse(
  readFileSync(path.join(base, 'package.json'), 'utf8')
) as Manifest;
const exported = Object.entries(manifest.exports);
const paths = exported.filter(
  (entry): entry is [ string, Target ] => typeof entry[1] === 'object'
);

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

//--------------------------------------------------------------------//
// Public types

//this compiles a small consumer the way an app would and returns the type
// errors found in that consumer only. A relative import reads the source; the
// package name resolves through the manifest to the built declarations. The
// consumer is a virtual file, so nothing is written to disk.
function compile(code: string) {
  const file = path.join(base, 'tests', 'consumer.virtual.ts');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    types: [ 'node' ]
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) => name === file
    ? ts.createSourceFile(name, code, language)
    : read(name, language, ...rest);
  const program = ts.createProgram([ file ], options, host);

  //the root re-exports from the types file, and an export it cannot find is
  // an error in the root, not in the consumer, so the root is read as well
  return [ file, path.join(base, 'src', 'index.ts') ]
    .map(name => program.getSourceFile(name))
    .filter((source): source is ts.SourceFile => source !== undefined)
    .flatMap(source => ts.getPreEmitDiagnostics(program, source))
    .map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
}

//these types are named in the signatures of the root's public values, so a
// consumer has to be able to name them
const named = [
  'AgentLock', 'McpSessionMode', 'ProviderOptions', 'ResolvedResponse',
  'ToolRequest'
];

//these are defined beside the runtime and the store, and exported by the root
const defined = [
  'AgentRuntime', 'RuntimeOptions', 'Sink',
  'Admission', 'AgentStore', 'Approval', 'Gate', 'NewAction', 'NewTurn',
  'Outcome', 'Usage'
];

//these are the two ways an app reaches the types: the source of this package,
// which is always there, and the declarations the build emits, which the
// manifest points at and an installed package ships. Both must name them.
describe('the public types', function() {
  //compiling loads the type libraries, which takes a while
  this.timeout(120000);

  //the same consumer is compiled against each way in
  const entries = [
    [ 'the source root', '../src/index.js' ],
    [ 'the source types path', '../src/types.js' ],
    [ 'the built package root', 'stackpress-ai' ],
    [ 'the built types path', 'stackpress-ai/types' ]
  ];

  for (const [ entry, from ] of entries) {
    const built = !from.startsWith('.');

    it(`names every promised type from ${entry}`, () => {
      //the built declarations come from `yarn build` in this package, which
      // the root build runs before the suite. A missing build is a failure
      // that says so, never a test that quietly does not run
      if (built) {
        expect(
          existsSync(path.join(base, 'cjs', 'types.d.ts')),
          'run `yarn build` in packages/stackpress-ai before this test'
        ).to.equal(true);
      }
      const names = [ ...named, ...defined ];
      //a generic type has to be given its argument to be used
      const used = names.map(name => name === 'ResolvedResponse'
        ? 'ResolvedResponse<unknown>'
        : name
      );
      const code = `import type { ${names.join(', ')} } from '${from}';\n`
        + `export type Used = [ ${used.join(', ')} ];\n`;
      expect(compile(code)).to.deep.equal([]);
    });
  }

  it('keeps a private type private', () => {
    const code = "import type { ClientTools } from '../src/index.js';\n"
      + 'export type Used = ClientTools;\n';
    const errors = compile(code).filter(text => text.includes('ClientTools'));
    expect(errors).to.have.length(1);
  });
});
