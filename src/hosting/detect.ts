/**
 * Project framework detection — inspects a directory and identifies the project type.
 *
 * @module linuxify/hosting/detect
 *
 * Detection matrix:
 *   vite.config.{js,ts}     → Vite (build + serve static)
 *   next.config.{js,mjs,ts} → Next.js (build + start)
 *   package.json (no framework) → Node.js (install + node entry)
 *   requirements.txt + app.py → Flask/FastAPI (pip install + gunicorn/uvicorn)
 *   composer.json            → PHP (composer install + php-fpm)
 *   index.html only          → Static (serve directory)
 */

import { join } from 'node:path';

import { exists, readFile } from '../utils/fs.js';
import { logger } from '../utils/log.js';

/**
 * The detected project type.
 */
export type ProjectType =
  | 'vite'
  | 'nextjs'
  | 'node'
  | 'flask'
  | 'fastapi'
  | 'php'
  | 'static'
  | 'unknown';

/**
 * Result of project detection.
 */
export interface DetectionResult {
  type: ProjectType;
  framework: string;
  entryPoint: string | null;
  buildCommand: string | null;
  startCommand: string;
  installCommand: string;
  outputDir: string | null;       // for build outputs (dist/, .next/, etc.)
  needsDatabase: boolean;
  detectedFiles: string[];
  confidence: number;              // 0-1
}

/**
 * Detect the project type by inspecting files in the given directory.
 *
 * @param projectPath — absolute path to the project directory
 * @returns detection result with deployment info
 */
export async function detectProject(projectPath: string): Promise<DetectionResult> {
  const detectedFiles: string[] = [];
  const checkFile = async (name: string): Promise<boolean> => {
    const exists_ = await exists(join(projectPath, name));
    if (exists_) detectedFiles.push(name);
    return exists_;
  };

  // Check for Vite
  const hasViteConfig = (await checkFile('vite.config.js')) || (await checkFile('vite.config.ts'));
  if (hasViteConfig) {
    return {
      type: 'vite',
      framework: 'Vite',
      entryPoint: null,
      buildCommand: 'npm run build',
      startCommand: 'npx serve dist',
      installCommand: 'npm install',
      outputDir: 'dist',
      needsDatabase: false,
      detectedFiles,
      confidence: 0.95,
    };
  }

  // Check for Next.js
  const hasNextConfig = (await checkFile('next.config.js')) || (await checkFile('next.config.mjs')) || (await checkFile('next.config.ts'));
  if (hasNextConfig) {
    return {
      type: 'nextjs',
      framework: 'Next.js',
      entryPoint: null,
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      installCommand: 'npm install',
      outputDir: '.next',
      needsDatabase: false,
      detectedFiles,
      confidence: 0.95,
    };
  }

  // Check for Node.js (package.json without known frameworks)
  const hasPackageJson = await checkFile('package.json');
  if (hasPackageJson) {
    const pkg = await readPackageJson(projectPath);
    const hasExpress = pkg?.dependencies?.['express'] !== undefined;
    const hasFastify = pkg?.dependencies?.['fastify'] !== undefined;
    const startScript = pkg?.scripts?.['start'] ?? `node ${pkg?.main ?? 'index.js'}`;

    return {
      type: 'node',
      framework: hasExpress ? 'Express' : hasFastify ? 'Fastify' : 'Node.js',
      entryPoint: pkg?.main ?? 'index.js',
      buildCommand: pkg?.scripts?.['build'] ?? null,
      startCommand: startScript,
      installCommand: 'npm install',
      outputDir: null,
      needsDatabase: pkg?.dependencies?.['pg'] !== undefined || pkg?.dependencies?.['mysql2'] !== undefined || pkg?.dependencies?.['redis'] !== undefined || pkg?.dependencies?.['mongoose'] !== undefined,
      detectedFiles,
      confidence: 0.8,
    };
  }

  // Check for Python (Flask/FastAPI)
  const hasRequirements = await checkFile('requirements.txt');
  const hasAppPy = await checkFile('app.py');
  const hasMainPy = await checkFile('main.py');
  if (hasRequirements && (hasAppPy || hasMainPy)) {
    const requirements = await readFile(join(projectPath, 'requirements.txt'));
    const reqText = requirements.toLowerCase();
    const isFastAPI = reqText.includes('fastapi');
    const isFlask = reqText.includes('flask');
    const entryFile = hasMainPy ? 'main.py' : 'app.py';

    if (isFastAPI) {
      return {
        type: 'fastapi',
        framework: 'FastAPI',
        entryPoint: entryFile,
        buildCommand: null,
        startCommand: `uvicorn ${entryFile.replace('.py', '')}:app --host 0.0.0.0 --port \${PORT}`,
        installCommand: 'pip install -r requirements.txt',
        outputDir: null,
        needsDatabase: reqText.includes('sqlalchemy') || reqText.includes('psycopg') || reqText.includes('redis'),
        detectedFiles,
        confidence: 0.9,
      };
    }

    if (isFlask) {
      return {
        type: 'flask',
        framework: 'Flask',
        entryPoint: entryFile,
        buildCommand: null,
        startCommand: `gunicorn ${entryFile.replace('.py', '')}:app --bind 0.0.0.0:\${PORT}`,
        installCommand: 'pip install -r requirements.txt',
        outputDir: null,
        needsDatabase: reqText.includes('flask-sqlalchemy') || reqText.includes('psycopg'),
        detectedFiles,
        confidence: 0.9,
      };
    }

    // Generic Python
    return {
      type: 'flask',
      framework: 'Python',
      entryPoint: entryFile,
      buildCommand: null,
      startCommand: `python ${entryFile}`,
      installCommand: 'pip install -r requirements.txt',
      outputDir: null,
      needsDatabase: false,
      detectedFiles,
      confidence: 0.6,
    };
  }

  // Check for PHP
  const hasComposer = await checkFile('composer.json');
  if (hasComposer) {
    return {
      type: 'php',
      framework: 'PHP',
      entryPoint: 'index.php',
      buildCommand: null,
      startCommand: 'php-fpm',
      installCommand: 'composer install',
      outputDir: null,
      needsDatabase: false,
      detectedFiles,
      confidence: 0.85,
    };
  }

  // Check for static (index.html)
  const hasIndexHtml = await checkFile('index.html');
  if (hasIndexHtml) {
    return {
      type: 'static',
      framework: 'Static',
      entryPoint: 'index.html',
      buildCommand: null,
      startCommand: 'npx serve .',
      installCommand: '',
      outputDir: null,
      needsDatabase: false,
      detectedFiles,
      confidence: 0.7,
    };
  }

  // Unknown
  logger.warn({ projectPath, detectedFiles }, 'hosting: could not detect project type');
  return {
    type: 'unknown',
    framework: 'Unknown',
    entryPoint: null,
    buildCommand: null,
    startCommand: '',
    installCommand: '',
    outputDir: null,
    needsDatabase: false,
    detectedFiles,
    confidence: 0.1,
  };
}

/**
 * Read and parse package.json.
 */
interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(projectPath: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(join(projectPath, 'package.json'));
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}
