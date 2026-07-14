// tests/unit/bootstrap/preflight.test.ts
//
// Unit tests for src/bootstrap/preflight.ts.
//
// All external dependencies (utils/process, utils/net, utils/fs, utils/log,
// utils/errors) are mocked via `vi.mock`. The tests exercise each check in
// isolation and the aggregate `runPreflight()` flow.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared via `vi.hoisted` so they are available to the hoisted
// `vi.mock` factory. Vitest hoists `vi.mock` calls to the top of the file
// (above all other statements); any variable referenced inside the factory
// must also be hoisted, hence the `vi.hoisted` wrapper.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const exec = vi.fn();
  const isTermux = vi.fn<() => boolean>();
  const isAndroid = vi.fn<() => boolean>();
  const getArch = vi.fn<() => string>();
  const getTermuxPrefix = vi.fn<() => string>();
  const isReachable = vi.fn<(url: string, opts?: unknown) => Promise<boolean>>();
  const exists = vi.fn<(p: string) => Promise<boolean>>();
  return { exec, isTermux, isAndroid, getArch, getTermuxPrefix, isReachable, exists };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  isTermux: mocks.isTermux,
  isAndroid: mocks.isAndroid,
  getArch: mocks.getArch,
  getTermuxPrefix: mocks.getTermuxPrefix,
  execOrThrow: vi.fn(),
}));

vi.mock('../../../src/utils/net.js', () => ({
  isReachable: mocks.isReachable,
  download: vi.fn(),
}));

vi.mock('../../../src/utils/fs.js', () => ({
  exists: mocks.exists,
  ensureDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('../../../src/utils/errors.js', () => ({
  LinuxifyError: class LinuxifyError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'LinuxifyError';
    }
  },
  BootstrapError: class BootstrapError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'BootstrapError';
    }
  },
}));

// ---------------------------------------------------------------------------
// SUT import — after mocks are registered.
// ---------------------------------------------------------------------------

import { runPreflight } from '../../../src/bootstrap/preflight.js';

// Destructure for convenience; values are the same `vi.fn` instances.
const { exec: mockExec, isTermux: mockIsTermux, isAndroid: mockIsAndroid,
  getArch: mockGetArch, getTermuxPrefix: mockGetTermuxPrefix,
  isReachable: mockIsReachable, exists: mockExists } = mocks;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Configure every check to its passing value. */
function configureHappyPath(): void {
  mockIsTermux.mockReturnValue(true);
  mockIsAndroid.mockReturnValue(true);
  mockGetArch.mockReturnValue('aarch64');
  mockGetTermuxPrefix.mockReturnValue('/data/data/com.termux/files/usr');
  // `pkg` exists.
  mockExists.mockResolvedValue(true);
  // dpkg -s com.termux reports a recent version.
  mockExec.mockImplementation((cmd: string) => {
    if (cmd === 'dpkg') {
      return Promise.resolve({
        exitCode: 0,
        stdout: 'Package: com.termux\nVersion: 0.118.0\n',
        stderr: '',
      });
    }
    if (cmd === 'getprop') {
      return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
    }
    if (cmd === 'df') {
      return Promise.resolve({
        exitCode: 0,
        stdout:
          'Filesystem     1K-blocks     Used Available Use% Mounted on\n/tmp            10000000  1000000   9000000  10% /\n',
        stderr: '',
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
  mockIsReachable.mockResolvedValue(true);
}

// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureHappyPath();
  });

  it('returns ok:true when every check passes', async () => {
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.checks).toHaveLength(6);
    for (const c of result.checks) {
      if (c.status === 'skipped') continue;
      expect(c.status).toBe('pass');
    }
  });

  it('throws E_BOOTSTRAP_FDROID_REQUIRED when not running inside Termux', async () => {
    mockIsTermux.mockReturnValue(false);
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_FDROID_REQUIRED',
    });
  });

  it('throws E_BOOTSTRAP_FDROID_REQUIRED when Termux version is below the minimum', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg') {
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Package: com.termux\nVersion: 0.101.0\n',
          stderr: '',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
    });
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_FDROID_REQUIRED',
    });
  });

  it('warns (does not fail) when Termux version cannot be determined', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg')
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no dpkg' });
      if (cmd === 'getprop')
        return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
      if (cmd === 'df')
        return Promise.resolve({
          exitCode: 0,
          stdout:
            'Filesystem 1K-blocks Used Avail Use% Mounted on\n/tmp 10000000 0 10000000 0% /\n',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.id === 'termux-source')).toBe(true);
  });

  it('throws E_BOOTSTRAP_ANDROID_TOO_OLD when API level < 28', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg')
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Package: com.termux\nVersion: 0.118.0\n',
          stderr: '',
        });
      if (cmd === 'getprop')
        return Promise.resolve({ exitCode: 0, stdout: '27\n', stderr: '' });
      if (cmd === 'df')
        return Promise.resolve({
          exitCode: 0,
          stdout:
            'Filesystem 1K-blocks Used Avail Use% Mounted on\n/tmp 10000000 0 10000000 0% /\n',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_ANDROID_TOO_OLD',
    });
  });

  it('skips Android version check when not on Android', async () => {
    mockIsAndroid.mockReturnValue(false);
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    const android = result.checks.find((c) => c.id === 'android-version');
    expect(android?.status).toBe('skipped');
  });

  it('warns when free space is below the soft threshold but above the hard threshold', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg')
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Package: com.termux\nVersion: 0.118.0\n',
          stderr: '',
        });
      if (cmd === 'getprop')
        return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
      // 1 GiB available — below 2 GiB soft, above 500 MiB hard.
      if (cmd === 'df')
        return Promise.resolve({
          exitCode: 0,
          stdout:
            'Filesystem 1K-blocks Used Avail Use% Mounted on\n/tmp 1000000 0 1048576 0% /\n',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.id === 'free-space')).toBe(true);
  });

  it('throws E_BOOTSTRAP_NO_SPACE when free space is below the hard threshold', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg')
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Package: com.termux\nVersion: 0.118.0\n',
          stderr: '',
        });
      if (cmd === 'getprop')
        return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
      // 100 MiB available — below the 500 MiB hard threshold.
      if (cmd === 'df')
        return Promise.resolve({
          exitCode: 0,
          stdout:
            'Filesystem 1K-blocks Used Avail Use% Mounted on\n/tmp 100000 0 102400 0% /\n',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_NO_SPACE',
    });
  });

  it('throws E_BOOTSTRAP_UNSUPPORTED_ARCH for unsupported architectures', async () => {
    mockGetArch.mockReturnValue('i386');
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_UNSUPPORTED_ARCH',
    });
  });

  it('normalises arm64 → aarch64 (pass)', async () => {
    mockGetArch.mockReturnValue('arm64');
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    const arch = result.checks.find((c) => c.id === 'architecture');
    expect(arch?.status).toBe('pass');
  });

  it('warns (does not fail) when running as root', async () => {
    const originalGetuid = process.getuid;
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    try {
      const result = await runPreflight();
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.id === 'no-root')).toBe(true);
    } finally {
      Object.defineProperty(process, 'getuid', {
        value: originalGetuid,
        configurable: true,
      });
    }
  });

  it('throws E_BOOTSTRAP_NO_NETWORK when every endpoint is unreachable', async () => {
    mockIsReachable.mockResolvedValue(false);
    await expect(runPreflight()).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_NO_NETWORK',
    });
  });

  it('skips the network check when offline:true', async () => {
    const result = await runPreflight({ offline: true });
    expect(result.ok).toBe(true);
    const network = result.checks.find((c) => c.id === 'network');
    expect(network?.status).toBe('skipped');
    expect(mockIsReachable).not.toHaveBeenCalled();
  });

  it('passes when at least one endpoint is reachable', async () => {
    mockIsReachable.mockImplementation((url: string) => {
      return Promise.resolve(url.includes('cdimage.ubuntu.com'));
    });
    const result = await runPreflight();
    expect(result.ok).toBe(true);
    const network = result.checks.find((c) => c.id === 'network');
    expect(network?.status).toBe('pass');
  });

  it('runs every check even when one fails', async () => {
    mockGetArch.mockReturnValue('mips');
    await expect(runPreflight()).rejects.toThrow();
    // Every check ran before the throw: dpkg, getprop (twice), df, isReachable.
    expect(mockExec).toHaveBeenCalled();
    expect(mockIsReachable).toHaveBeenCalled();
  });
});
