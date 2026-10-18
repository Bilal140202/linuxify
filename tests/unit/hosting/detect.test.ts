/**
 * Unit tests for `src/hosting/detect.ts` — the `detectProject()` function.
 *
 * Covers:
 *   - Each supported project type (vite, nextjs, node, fastapi, flask,
 *     generic python, php, static, unknown).
 *   - Framework inference (Express, Fastify, plain Node.js).
 *   - startScript fallback to `node ${pkg.main ?? 'index.js'}`.
 *   - `needsDatabase` heuristic for Node and Python projects.
 *   - `confidence` per type.
 *   - `detectedFiles` populated correctly (file list grows as checks run).
 *   - Edge cases: malformed package.json, nonexistent directory.
 *
 * The logger is mocked (pino's lazy initializer opens a log file in
 * `~/.linuxify/logs/` and is flaky under vitest's stdio capture). Each test
 * gets a fresh tmpdir via `mkdtemp` + `LINUXIFY_HOME` so the optional
 * `logger.warn` call in the unknown-branch never escapes into a real log
 * file on disk.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the logger — pino's lazy initializer opens a real log file under
// ~/.linuxify/logs/ and crashes under vitest's stdio capture.
vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import { detectProject } from '../../../src/hosting/detect.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Write the given files (name → contents) into a fresh tmpdir and return its path. */
async function makeProject(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'linuxify-detect-'));
  for (const [name, contents] of Object.entries(files)) {
    const fullPath = join(dir, name);
    // Create any nested directories the path implies.
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, contents, 'utf8');
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Vite
// ---------------------------------------------------------------------------

describe('detectProject — Vite', () => {
  let project: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    project = await makeProject({
      'vite.config.js': 'export default {};\n',
      'package.json': JSON.stringify({ name: 'vite-app' }),
    });
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it('detects vite.config.js → type "vite"', async () => {
    const r = await detectProject(project.dir);
    expect(r.type).toBe('vite');
  });

  it('detects vite.config.ts → type "vite"', async () => {
    const p2 = await makeProject({ 'vite.config.ts': 'export default {};\n' });
    const r = await detectProject(p2.dir);
    expect(r.type).toBe('vite');
    await p2.cleanup();
  });

  it('reports framework "Vite"', async () => {
    const r = await detectProject(project.dir);
    expect(r.framework).toBe('Vite');
  });

  it('uses buildCommand "npm run build"', async () => {
    const r = await detectProject(project.dir);
    expect(r.buildCommand).toBe('npm run build');
  });

  it('uses startCommand "npx serve dist"', async () => {
    const r = await detectProject(project.dir);
    expect(r.startCommand).toBe('npx serve dist');
  });

  it('reports outputDir "dist"', async () => {
    const r = await detectProject(project.dir);
    expect(r.outputDir).toBe('dist');
  });

  it('reports confidence 0.95', async () => {
    const r = await detectProject(project.dir);
    expect(r.confidence).toBe(0.95);
  });

  it('records vite.config.js in detectedFiles', async () => {
    const r = await detectProject(project.dir);
    expect(r.detectedFiles).toContain('vite.config.js');
  });
});

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

describe('detectProject — Next.js', () => {
  it('detects next.config.js → type "nextjs"', async () => {
    const p = await makeProject({ 'next.config.js': 'module.exports = {};\n' });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('nextjs');
    expect(r.framework).toBe('Next.js');
    expect(r.startCommand).toBe('npm start');
    expect(r.buildCommand).toBe('npm run build');
    expect(r.outputDir).toBe('.next');
    expect(r.confidence).toBe(0.95);
    await p.cleanup();
  });

  it('detects next.config.mjs → type "nextjs"', async () => {
    const p = await makeProject({ 'next.config.mjs': 'export default {};\n' });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('nextjs');
    await p.cleanup();
  });

  it('detects next.config.ts → type "nextjs"', async () => {
    const p = await makeProject({ 'next.config.ts': 'export default {};\n' });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('nextjs');
    await p.cleanup();
  });

  it('populates detectedFiles with only the matched next.config.* file', async () => {
    const p = await makeProject({ 'next.config.mjs': 'export default {};\n' });
    const r = await detectProject(p.dir);
    expect(r.detectedFiles).toContain('next.config.mjs');
    // No other files exist; the array should have exactly one entry.
    expect(r.detectedFiles).toHaveLength(1);
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Node.js / Express / Fastify
// ---------------------------------------------------------------------------

describe('detectProject — Node.js', () => {
  it('detects plain package.json → type "node", framework "Node.js"', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ name: 'svc', main: 'server.js' }),
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('node');
    expect(r.framework).toBe('Node.js');
    expect(r.startCommand).toBe('node server.js');
    expect(r.entryPoint).toBe('server.js');
    expect(r.installCommand).toBe('npm install');
    expect(r.buildCommand).toBeNull();
    expect(r.outputDir).toBeNull();
    expect(r.confidence).toBe(0.8);
    await p.cleanup();
  });

  it('falls back to "index.js" when package.json has no "main"', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ name: 'svc' }),
    });
    const r = await detectProject(p.dir);
    expect(r.entryPoint).toBe('index.js');
    expect(r.startCommand).toBe('node index.js');
    await p.cleanup();
  });

  it('uses package.json scripts.start when present (no main field)', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ name: 'svc', scripts: { start: 'node dist/main.js' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.startCommand).toBe('node dist/main.js');
    await p.cleanup();
  });

  it('detects Express dependency → framework "Express"', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({
        name: 'svc',
        main: 'app.js',
        dependencies: { express: '^4.18.2' },
      }),
    });
    const r = await detectProject(p.dir);
    expect(r.framework).toBe('Express');
    await p.cleanup();
  });

  it('detects Fastify dependency → framework "Fastify"', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({
        name: 'svc',
        main: 'app.js',
        dependencies: { fastify: '^4.0.0' },
      }),
    });
    const r = await detectProject(p.dir);
    expect(r.framework).toBe('Fastify');
    await p.cleanup();
  });

  it('exposes scripts.build as buildCommand when present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({
        name: 'svc',
        main: 'app.js',
        scripts: { build: 'tsc -p .' },
      }),
    });
    const r = await detectProject(p.dir);
    expect(r.buildCommand).toBe('tsc -p .');
    await p.cleanup();
  });

  it('needsDatabase = true when pg dependency present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({
        name: 'svc',
        dependencies: { pg: '^8.0.0' },
      }),
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when mysql2 dependency present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ dependencies: { mysql2: '^3.0.0' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when redis dependency present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when mongoose dependency present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ dependencies: { mongoose: '^8.0.0' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = false when no DB-related dependency is present', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ dependencies: { express: '^4.18.2' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });

  it('records package.json in detectedFiles', async () => {
    const p = await makeProject({
      'package.json': JSON.stringify({ name: 'svc' }),
    });
    const r = await detectProject(p.dir);
    expect(r.detectedFiles).toContain('package.json');
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Python FastAPI
// ---------------------------------------------------------------------------

describe('detectProject — Python FastAPI', () => {
  it('detects requirements.txt with fastapi + main.py → type "fastapi"', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\nuvicorn\n',
      'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('fastapi');
    expect(r.framework).toBe('FastAPI');
    expect(r.entryPoint).toBe('main.py');
    expect(r.installCommand).toBe('pip install -r requirements.txt');
    expect(r.buildCommand).toBeNull();
    expect(r.startCommand).toBe('uvicorn main:app --host 0.0.0.0 --port ${PORT}');
    expect(r.confidence).toBe(0.9);
    await p.cleanup();
  });

  it('uses app.py as entry point when main.py is absent', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\nuvicorn\n',
      'app.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    });
    const r = await detectProject(p.dir);
    expect(r.entryPoint).toBe('app.py');
    expect(r.startCommand).toBe('uvicorn app:app --host 0.0.0.0 --port ${PORT}');
    await p.cleanup();
  });

  it('needsDatabase = true when requirements.txt mentions sqlalchemy', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\nsqlalchemy\n',
      'main.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when requirements.txt mentions psycopg', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\npsycopg[binary]\n',
      'main.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when requirements.txt mentions redis (python redis client)', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\nredis\n',
      'main.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('records requirements.txt + main.py/app.py in detectedFiles', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\n',
      'main.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.detectedFiles).toContain('requirements.txt');
    expect(r.detectedFiles).toContain('main.py');
    await p.cleanup();
  });

  it('does NOT match when requirements.txt exists but no main.py / app.py', async () => {
    const p = await makeProject({
      'requirements.txt': 'fastapi\n',
      // No main.py / app.py — should not be detected as fastapi.
    });
    const r = await detectProject(p.dir);
    expect(r.type).not.toBe('fastapi');
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Python Flask
// ---------------------------------------------------------------------------

describe('detectProject — Python Flask', () => {
  it('detects requirements.txt with flask → type "flask", framework "Flask"', async () => {
    const p = await makeProject({
      'requirements.txt': 'flask\ngunicorn\n',
      'main.py': 'from flask import Flask\napp = Flask(__name__)\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('flask');
    expect(r.framework).toBe('Flask');
    expect(r.entryPoint).toBe('main.py');
    expect(r.startCommand).toBe('gunicorn main:app --bind 0.0.0.0:${PORT}');
    expect(r.confidence).toBe(0.9);
    await p.cleanup();
  });

  it('uses app.py entry point when main.py is absent', async () => {
    const p = await makeProject({
      'requirements.txt': 'flask\n',
      'app.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.entryPoint).toBe('app.py');
    expect(r.startCommand).toBe('gunicorn app:app --bind 0.0.0.0:${PORT}');
    await p.cleanup();
  });

  it('needsDatabase = true when flask-sqlalchemy present', async () => {
    const p = await makeProject({
      'requirements.txt': 'flask\nflask-sqlalchemy\n',
      'app.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = true when psycopg present (flask project)', async () => {
    const p = await makeProject({
      'requirements.txt': 'flask\npsycopg2-binary\n',
      'app.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(true);
    await p.cleanup();
  });

  it('needsDatabase = false for a plain flask project', async () => {
    const p = await makeProject({
      'requirements.txt': 'flask\ngunicorn\n',
      'app.py': 'app = 1\n',
    });
    const r = await detectProject(p.dir);
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Generic Python (requirements.txt without flask/fastapi)
// ---------------------------------------------------------------------------

describe('detectProject — Generic Python', () => {
  it('detects requirements.txt (no flask/fastapi) → type "flask", framework "Python"', async () => {
    const p = await makeProject({
      'requirements.txt': 'requests\nnumpy\n',
      'main.py': 'print("hello")\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('flask');
    expect(r.framework).toBe('Python');
    expect(r.startCommand).toBe('python main.py');
    expect(r.confidence).toBe(0.6);
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });

  it('uses app.py as entry when main.py is absent', async () => {
    const p = await makeProject({
      'requirements.txt': 'requests\n',
      'app.py': 'print("hello")\n',
    });
    const r = await detectProject(p.dir);
    expect(r.startCommand).toBe('python app.py');
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe('detectProject — PHP', () => {
  it('detects composer.json → type "php"', async () => {
    const p = await makeProject({
      'composer.json': JSON.stringify({ require: { 'php': '^8.0' } }),
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('php');
    expect(r.framework).toBe('PHP');
    expect(r.entryPoint).toBe('index.php');
    expect(r.startCommand).toBe('php-fpm');
    expect(r.installCommand).toBe('composer install');
    expect(r.buildCommand).toBeNull();
    expect(r.confidence).toBe(0.85);
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });

  it('records composer.json in detectedFiles', async () => {
    const p = await makeProject({ 'composer.json': '{}' });
    const r = await detectProject(p.dir);
    expect(r.detectedFiles).toContain('composer.json');
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Static (index.html only)
// ---------------------------------------------------------------------------

describe('detectProject — Static', () => {
  it('detects index.html only → type "static"', async () => {
    const p = await makeProject({
      'index.html': '<!DOCTYPE html><html><body>hi</body></html>\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('static');
    expect(r.framework).toBe('Static');
    expect(r.entryPoint).toBe('index.html');
    expect(r.startCommand).toBe('npx serve .');
    expect(r.installCommand).toBe('');
    expect(r.buildCommand).toBeNull();
    expect(r.outputDir).toBeNull();
    expect(r.confidence).toBe(0.7);
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });

  it('records index.html in detectedFiles', async () => {
    const p = await makeProject({ 'index.html': '<!DOCTYPE html>\n' });
    const r = await detectProject(p.dir);
    expect(r.detectedFiles).toEqual(['index.html']);
    await p.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Unknown / empty directory
// ---------------------------------------------------------------------------

describe('detectProject — Unknown', () => {
  it('empty directory → type "unknown", confidence 0.1', async () => {
    const p = await makeProject({});
    const r = await detectProject(p.dir);
    expect(r.type).toBe('unknown');
    expect(r.framework).toBe('Unknown');
    expect(r.confidence).toBe(0.1);
    expect(r.startCommand).toBe('');
    expect(r.installCommand).toBe('');
    expect(r.buildCommand).toBeNull();
    expect(r.needsDatabase).toBe(false);
    expect(r.detectedFiles).toEqual([]);
    await p.cleanup();
  });

  it('nonexistent directory → type "unknown" (all exists() checks return false)', async () => {
    const r = await detectProject(join(tmpdir(), 'does-not-exist-' + Date.now()));
    expect(r.type).toBe('unknown');
    expect(r.confidence).toBe(0.1);
    expect(r.detectedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('detectProject — edge cases', () => {
  it('malformed package.json (JSON.parse fails) → still type "node" with null fields', async () => {
    const p = await makeProject({
      'package.json': '{ this is not valid json',
    });
    const r = await detectProject(p.dir);
    // The catch block in readPackageJson swallows the parse error and
    // returns null — the caller then sees type 'node' with all the
    // empty-pkg fallbacks.
    expect(r.type).toBe('node');
    expect(r.framework).toBe('Node.js');
    expect(r.entryPoint).toBe('index.js');
    expect(r.startCommand).toBe('node index.js');
    expect(r.buildCommand).toBeNull();
    expect(r.needsDatabase).toBe(false);
    await p.cleanup();
  });

  it('files are checked in priority order: vite.config beats package.json', async () => {
    const p = await makeProject({
      'vite.config.js': 'export default {};\n',
      'package.json': JSON.stringify({ name: 'svc' }),
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('vite');
    // package.json was also probed for existence (since checkFile is called
    // unconditionally per branch). Actually the vite branch returns before
    // reaching the package.json check, so detectedFiles should NOT contain
    // package.json here.
    expect(r.detectedFiles).not.toContain('package.json');
    await p.cleanup();
  });

  it('next.config beats package.json', async () => {
    const p = await makeProject({
      'next.config.js': 'module.exports = {};\n',
      'package.json': JSON.stringify({ name: 'svc' }),
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('nextjs');
    expect(r.detectedFiles).not.toContain('package.json');
    await p.cleanup();
  });

  it('composer.json (php) takes precedence over index.html (static)', async () => {
    const p = await makeProject({
      'composer.json': '{}',
      'index.html': '<!DOCTYPE html>\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('php');
    // The PHP branch returns immediately on composer.json detection —
    // index.html is never probed.
    expect(r.detectedFiles).toEqual(['composer.json']);
    await p.cleanup();
  });

  it('requires requirements.txt AND main.py/app.py for python detection', async () => {
    // requirements.txt present but neither main.py nor app.py — falls
    // through to composer / static / unknown.
    const p = await makeProject({
      'requirements.txt': 'flask\n',
    });
    const r = await detectProject(p.dir);
    expect(r.type).toBe('unknown');
    expect(r.detectedFiles).toContain('requirements.txt');
    await p.cleanup();
  });
});
