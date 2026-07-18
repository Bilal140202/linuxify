import tsup from 'tsup';

export default tsup.defineConfig({
  entry: ['src/cli/index.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  shims: false,
  splitting: false,
  // No banner — the shebang lives in src/cli/index.ts itself so it lands
  // only in the CLI entry, not in the library entry (src/index.ts).
});
