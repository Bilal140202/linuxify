# Contributing to Linuxify

Thanks for your interest in contributing to Linuxify! 🎉

Linuxify is a community-built project. We welcome contributors of all skill
levels — whether you're fixing a typo, adding a new package to the registry,
writing a patch for an unsupported CLI, or implementing a core subsystem.

## Read This First

- **Code of Conduct**: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — be
  excellent to each other.
- **Contribution Guidelines**: [`docs/16-community/contribution-guidelines.md`](./docs/16-community/contribution-guidelines.md) —
  the full process for code, docs, packages, patches, plugins.
- **Developer Setup**: [`docs/16-community/developer-setup.md`](./docs/16-community/developer-setup.md) —
  how to clone, build, test, and run Linuxify from source.
- **AI Build Guide**: [`docs/00-executive/ai-build-guide.md`](./docs/00-executive/ai-build-guide.md) —
  if you're an AI coding agent (or working with one), start here for the
  recommended build order and critical implementation notes.
- **Security Policy**: [`SECURITY.md`](./SECURITY.md) — how to report
  vulnerabilities. **Do not open public issues for security reports.**

## Quick Start for Contributors

```bash
git clone https://github.com/Bilal140202/linuxify.git
cd linuxify
npm install
npm run build
npm link
linuxify --version
```

## Ways to Contribute

- **Code**: features, bug fixes, refactors. See
  [`docs/16-community/contribution-guidelines.md`](./docs/16-community/contribution-guidelines.md).
- **Documentation**: typos, new guides, translations. All docs are in
  Markdown under `docs/`.
- **Package definitions**: add a new CLI to the registry. See
  [`docs/09-registry/package-spec.md`](./docs/09-registry/package-spec.md).
- **Patches**: write a compatibility patch for an unsupported CLI. See
  [`docs/08-patcher/patcher-engine.md`](./docs/08-patcher/patcher-engine.md).
- **Testing**: reproduce bugs, test on different devices.
- **Support**: answer questions in Discord and GitHub Discussions.
- **Design**: logo, icons, illustrations. See
  [`docs/17-branding/branding-guide.md`](./docs/17-branding/branding-guide.md).
- **Localization**: translate Linuxify's UI strings. See
  [`docs/16-community/internationalization.md`](./docs/16-community/internationalization.md).

## Pull Request Process

1. Fork the repo and create a branch: `feat/<short-desc>` or
   `fix/<issue#>-<desc>`.
2. Make your changes following the
   [code style guide](./docs/16-community/contribution-guidelines.md#5-code-style).
3. Add or update tests. See
   [testing strategy](./docs/12-testing/testing-strategy.md).
4. Update documentation if your change is user-visible.
5. Update [`CHANGELOG.md`](./CHANGELOG.md) under `[Unreleased]`.
6. Commit using [Conventional Commits](https://www.conventionalcommits.org/)
   format with [DCO sign-off](https://developercertificate.org/):
   `git commit -s -m "feat: add support for distro X"`.
7. Push and open a pull request using the
   [PR template](./.github/PULL_REQUEST_TEMPLATE.md).
8. CI must pass. A maintainer will review and merge.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT license](./LICENSE). We use DCO (Developer Certificate of Origin)
sign-off instead of a CLA — see
[`docs/20-adrs/adr-012-no-cla-dco-only.md`](./docs/20-adrs/adr-012-no-cla-dco-only.md)
for the rationale.

## Getting Help

- **Discord**: [`#dev` channel](https://discord.gg/linuxify) — real-time help.
- **GitHub Discussions**: for design questions and RFCs.
- **Office hours**: monthly, announced on Discord.
- **Pair with a maintainer**: especially for first-time contributors — just
  ask in `#dev`.

## Recognition

All contributors are added to `CONTRIBUTORS.md` (to be generated from git
history). Significant contributions are recognized in release notes. Annual
contributor awards across 8 categories — see
[`docs/16-community/contribution-guidelines.md`](./docs/16-community/contribution-guidelines.md#13-recognition).

We're glad you're here. Let's build the Homebrew for Android/Linux CLIs
together. 🐧🤖
