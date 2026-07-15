/**
 * Environment Discovery — detects existing Termux/proot/distro/runtime state.
 *
 * @module linuxify/discovery
 *
 * Discovery is the "understand before acting" phase. Before Linuxify installs
 * anything, it scans the system to find:
 *
 *   - Is Termux installed? From F-Droid or Play Store?
 *   - Is proot/proot-distro installed and working?
 *   - Are there existing proot-distro containers (ubuntu, debian, arch, alpine)?
 *   - Inside each container, what runtimes are installed (Node, Python, Git)?
 *   - What packages are already installed inside each container?
 *
 * This lets Linuxify:
 *   1. **Adopt** existing environments instead of reinstalling (saves 10+ min)
 *   2. **Skip** stages that are already complete (smart bootstrap)
 *   3. **Report** accurately ("Found existing Ubuntu with Node 24, Python 3.12")
 *
 * The discovery engine is read-only — it never modifies state. It just reports
 * what it finds. The caller (bootstrap, repair, or the `adopt` command) decides
 * what to do with the results.
 *
 * @packageDocumentation
 */

export {
  discoverEnvironment,
  type DiscoveryResult,
  type DiscoveredDistro,
  type DiscoveredRuntime,
  type DiscoveredPackage,
  type HostEnvironment,
} from './engine.js';
