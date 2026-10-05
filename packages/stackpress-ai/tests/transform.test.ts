//node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import { parse } from '@stackpress/idea-parser';
import { expect } from 'chai';
import { describe, it } from 'mocha';
import Schema from 'stackpress-schema/Schema';
import { createProject } from 'stackpress-schema/transform/helpers';
import type Column from 'stackpress-schema/Column';
//client
import generate from '../src/transform/index.js';
import { generateTool } from '../src/transform/tools.js';
import { columnToJsonSchema, modelScope } from '../src/transform/helpers.js';

/**
 * Cache the parsed blog schema so the suite stays aligned with the live
 * template without reparsing the idea file for every call.
 */
let blogSchema: Record<string, unknown> | null = null;

/**
 * Load the current blog template schema from schema.idea.
 */
function loadBlogSchema() {
  if (blogSchema) {
    return blogSchema;
  }

  const tests = path.dirname(fileURLToPath(import.meta.url));
  const idea = path.resolve(
    tests,
    '../../../templates/blog/schema.idea'
  );
  const source = fs.readFileSync(idea, 'utf-8');

  blogSchema = parse(source) as Record<string, unknown>;
  return blogSchema;
}

describe('ai/transform', () => {
  it('should generate client tool registries for blog models', async function() {
    this.timeout(10000);

    //build the transform output in a temp project so the assertions stay
    // isolated from the template's committed generated files.
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stackpress-ai-transform-')
    );
    const project = await createProject(tmpdir);
    const directory = project.createDirectory(tmpdir);
    const schema = loadBlogSchema();

    await generate({
      config: {},
      cwd: tmpdir,
      directory,
      project,
      schema,
      terminal: {} as never,
      transformer: {} as never
    });

    //inspect the generated registry surface the runtime depends on.
    const tools = directory.getSourceFileOrThrow('tools.ts');
    const index = directory.getSourceFileOrThrow('index.ts');
    const articleTools = directory.getSourceFileOrThrow(
      'Article/tools/index.ts'
    );
    const articleCreate = directory.getSourceFileOrThrow(
      'Article/tools/create.ts'
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(tmpdir, 'package.json'), 'utf-8')
    ) as {
      exports: Record<string, string>
    };

    expect(index.getFullText()).to.match(
      /import tools from ['"]\.\/tools\.js['"];/
    );
    expect(index.getFullText()).to.contain('export { tools };');
    expect(tools.getFullText()).to.contain('ArticleTools.listen(emitter);');
    expect(articleTools.getFullText()).to.contain(
      "'article-detail-tool'"
    );
    expect(articleTools.getFullText()).to.contain(
      "'article-update-tool'"
    );
    expect(articleCreate.getFullText()).to.contain('"event": "article-create"');
    expect(packageJson.exports['./tools']).to.equal('./tools.js');
    expect(packageJson.exports['./Article/tools']).to.equal(
      './Article/tools/index.js'
    );
  });

  it('should stay idempotent when generation runs a second time', async function () {
    this.timeout(15000);

    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stackpress-ai-transform-idempotent-')
    );
    const project = await createProject(tmpdir);
    const directory = project.createDirectory(tmpdir);
    const schema = loadBlogSchema();

    //regenerating twice should not duplicate the root tools import/export,
    // exercising the "already present" branches that the first run of a
    // fresh project never reaches.
    await generate({
      config: {},
      cwd: tmpdir,
      directory,
      project,
      schema,
      terminal: {} as never,
      transformer: {} as never
    });
    await generate({
      config: {},
      cwd: tmpdir,
      directory,
      project,
      schema,
      terminal: {} as never,
      transformer: {} as never
    });

    const index = directory.getSourceFileOrThrow('index.ts');
    const text = index.getFullText();
    const importMatches = text.match(/from ['"]\.\/tools\.js['"]/g) || [];
    const exportMatches = text.match(/export \{ tools \};/g) || [];

    expect(importMatches).to.have.length(1);
    expect(exportMatches).to.have.length(1);
  });

  it('should no-op for a generated tool operation outside the approved rollout', async () => {
    const tmpdir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stackpress-ai-transform-noop-')
    );
    const project = await createProject(tmpdir);
    const directory = project.createDirectory(tmpdir);
    const schema = Schema.make(loadBlogSchema());
    const [ model ] = Array.from(schema.models.values());

    //the generated-tool surface is intentionally limited to search, detail,
    // create and update; any other operation must be dropped rather than
    // crash the generator.
    expect(() => generateTool(directory, model, 'delete' as never))
      .to.not.throw();
    expect(directory.getSourceFiles().some(
      file => file.getFilePath().endsWith('/delete.ts')
    )).to.equal(false);
  });

  it('should derive the plural kebab-case scope prefix for a real model', () => {
    const schema = Schema.make(loadBlogSchema());
    const [ model ] = Array.from(schema.models.values());

    expect(modelScope(model)).to.be.a('string');
    expect(modelScope(model)).to.match(/^[a-z0-9-]+$/);
  });

  it('should build a schema fragment without a description when the column has none', () => {
    const column = {
      type: { name: 'String', multiple: false },
      document: {}
    } as unknown as Column;

    expect(columnToJsonSchema(column)).to.deep.equal({ type: 'string' });
  });
});
