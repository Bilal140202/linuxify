# Internationalization (i18n)

> **Audience**: Contributors who want to translate Linuxify into their language, maintainers reviewing translation PRs, and AI coding agents implementing i18n-aware features.
>
> **Scope**: This document defines what is translated, what is not, the framework, the translation workflow, pluralisation rules, RTL support, quality bars, and the initial set of languages v1 ships with. For the CLI commands that expose i18n configuration (`linuxify config i18n.locale`), see [cli-specification.md](../03-cli/cli-specification.md).

## 1. Why i18n?

Linuxify users are global. The project's [target audience](../../.agent-context.md#8-target-users) — developers using Android phones to run Linux CLIs — is concentrated in regions where English is not the first language: South Asia (India, Pakistan, Bangladesh), Southeast Asia (Indonesia, Philippines, Vietnam), East Asia (China, Japan, Korea), Latin America (Brazil, Mexico, Argentina), the Middle East (Egypt, Saudi Arabia, UAE), and Francophone and Hispanophone Africa. A CLI that prints "Storage insufficient" to a user who reads "Almacenamiento insuficiente" faster than English is a CLI that is harder to use than it needs to be.

CLI messages, doctor output, error messages, and interactive prompts should therefore be translatable. The bar is not "every string is translated into every language" — that is impossible without a translation team the project does not have — but "every user-facing string is *translatable*, and the project ships complete translations for the top 9 languages by user count". Documentation can be translated by the community, with the same bar: the docs are translatable (Markdown, no hardcoded English-only constructs), and the project hosts official translations for the top 5 languages once telemetry identifies them.

The decision to invest in i18n early — even before v1.0 — is deliberate. Retrofitting i18n onto a CLI that has hardcoded English strings everywhere is a multi-month project that touches every file. Building i18n in from the start costs ~5% extra effort per feature and pays off the moment the first non-English translation lands. This is the same calculus that led `git`, `cargo`, and `apt` to invest in i18n early.

## 2. Scope

What is translated:

- **CLI user-facing strings**: command descriptions, flag descriptions, error messages, success messages, progress indicators, interactive prompts (y/n questions, multiple-choice menus).
- **Doctor output**: the table headers, the `✔`/`✖`/`⚠` status labels, the remediation hints, the summary line.
- **Launcher output**: messages printed by the launcher shim (e.g., "Entering proot for cline...").
- **Interactive prompts**: the `linuxify init` flow's multiple-choice prompts, the `linuxify add` adoption prompt, the `linuxify self-update` confirmation.

What is NOT translated:

- **Code and code comments**: source code is English-only. Comments are English-only. This is a hard rule; mixing languages in source makes contribution impossible.
- **Log messages**: the structured JSON logs at `~/.linuxify/logs/linuxify.log` are English-only, because they are developer-facing (used for debugging and support) and because log-analysis tooling (grep, ELK) works best on a single language. The CLI's stdout/stderr may be translated, but the structured logs are not.
- **Commit messages**: Conventional Commits (`feat:`, `fix:`, etc.) are English-only, per [contribution-guidelines §5](./contribution-guidelines.md#5-code-style).
- **Package YAML** (`packages/*.yml`): the `name`, `install`, `patches`, `env`, `doctor` fields are technical and machine-read; translating them would break the schema. The `description` field is translatable via a `descriptions:` map keyed by locale, but the default is English.
- **Technical terms**: `proot`, `distro`, `runtime`, `launcher`, `patch`, `manifest`, `bootstrap`, `flock` — these are project-specific jargon with no clean translation in most languages. They stay English even in translated output, the same way "git" stays "git" in French Git documentation.

## 3. Framework

Linuxify uses [i18next](https://www.i18next.com/), the de facto standard i18n library in the Node.js ecosystem. i18next handles interpolation, pluralisation, fallback, and locale detection; it is mature, well-documented, and used by major projects (Next.js, SolidStart, many CLIs).

Locale files live at `locales/<lang>.json`, where `<lang>` is an [IETF BCP 47 language tag](https://www.rfc-editor.org/rfc/rfc5646) (e.g., `en`, `es`, `fr`, `pt-BR`, `zh-CN`). The default locale is `en`; if a translation is missing for a key in the active locale, i18next falls back to `en` automatically. This means an incomplete translation does not break the CLI — it produces a mix of translated and English strings, which is ugly but functional.

The `en` locale is the source of truth. Translators translate from `en` to their language. New strings are authored in `en` by developers, extracted to `locales/en.json` by `npm run i18n:extract`, and translated by community members.

```typescript
// src/i18n.ts
import i18next from 'i18next';

await i18next.init({
  lng: detectLocale(),
  fallbackLng: 'en',
  resources: {
    en: { translation: require('../locales/en.json') },
    es: { translation: require('../locales/es.json') },
    // ... other locales
  },
});

// Usage anywhere in the codebase:
import { t } from './i18n';
console.log(t('doctor.storage_ok', { free: '11.8 GB' }));
// en: "Storage: 11.8 GB free"
// es: "Almacenamiento: 11.8 GB libres"
```

## 4. Locale Detection

Locale is detected in priority order: CLI flag > config > env var > default.

1. **CLI flag** (`--locale fr`): highest priority. Set per-invocation; does not persist.
2. **Config** (`linuxify config i18n.locale fr`): stored in `~/.linuxify/config.toml`, persists across invocations. Set once, applies everywhere.
3. **`LC_ALL` env var**: standard Unix locale override. If set to `fr_FR.UTF-8`, Linuxify uses `fr`.
4. **`LANG` env var**: standard Unix locale. If `LC_ALL` is unset, Linuxify uses `LANG`. `fr_FR.UTF-8` → `fr`.
5. **Default (`en`)**: if none of the above is set or none matches a known locale.

The detection logic is in `src/i18n/detect.ts` and is well-tested. The precedence (flag > config > env > default) lets users override per-invocation without losing their default, and lets system administrators set a sensible default via `LANG` without preventing users from overriding.

To check which locale Linuxify is using:

```bash
$ linuxify config i18n.locale
fr

$ linuxify --locale es doctor
# Output in Spanish for this invocation only.
```

## 5. String Extraction

The `npm run i18n:extract` script scans the source tree for `t('key', ...)` calls and updates `locales/en.json` with any new keys. New keys are added with the English value extracted from the `t()` call's default (if provided) or an empty string (if the call has no default, the developer must fill it in). Removed keys are *flagged* with a `_removed: true` marker but not auto-deleted — translators may want to reuse the translation for a renamed key, so deletion is a manual step.

```bash
$ npm run i18n:extract
Extracting i18n strings from src/...
  locales/en.json: 412 keys (3 new, 0 removed, 1 renamed)
Done. Review changes and commit.
```

The extraction script is `scripts/i18n-extract.ts`, built on `@formatjs/icu-messageformat-parser` for ICU MessageFormat compatibility (which i18next supports). Run it before every PR that adds or changes user-facing strings; CI runs it on every PR and fails if `locales/en.json` is out of date (a common mistake is to add a `t()` call but forget to run extraction).

## 6. Translation Workflow

The translation workflow is designed to be contributor-friendly and low-friction.

1. **Strings are authored in English by developers**, inline in the source via `t('key')` calls. The English value lives in `locales/en.json`.
2. **`locales/en.json` is the source of truth.** Translators translate from it; never the other way around.
3. **Translators (community members) translate to `locales/<lang>.json`.** Each locale file is a flat JSON object mapping keys to translated strings.
4. **Weblate integration (future, post-v1):** a web-based translation UI at `translate.linuxify.sh` lets translators work in a browser without touching git. Weblate auto-syncs with the GitHub repo, so a translator's work becomes a PR automatically. For v1, translations are submitted as standard PRs against `locales/<lang>.json`.
5. **Translations are merged via PR**, reviewed by a native speaker (see §10), and released with the next version.
6. **Translators are credited** in `CONTRIBUTORS.md` and in the release notes for the version that includes their translation.

To start translating a new language:

1. Check `locales/` to see if your language already has a file. If yes, fork the repo, improve the existing translations, open a PR. If no, copy `locales/en.json` to `locales/<your-lang>.json`, translate every value (do not translate the keys), open a PR.
2. In the PR, mention your language in the description and tag `@linuxify/i18n` for review.
3. A native speaker (or the project maintainer for the language, if one exists) reviews. Once approved, the PR merges and the translation ships in the next release.

## 7. Pluralization

i18next handles plural rules per locale automatically via the [Unicode CLDR plural rules](https://cldr.unicode.org/index/cldr-spec/plural-rules). Use the `count` option:

```typescript
t('installed_packages', { count: 5 });
// en: "5 packages installed"
// fr: "5 paquets installés"
// ru: "5 пакетов установлено" (note: Russian uses a different plural form for 5)

t('installed_packages', { count: 1 });
// en: "1 package installed"
// fr: "1 paquet installé"
// ru: "1 пакет установлен" (different form again)
```

The locale file declares the plural forms explicitly:

```json
// locales/en.json
{
  "installed_packages_one": "{{count}} package installed",
  "installed_packages_other": "{{count}} packages installed"
}

// locales/ru.json (Russian has 3 plural forms: one, few, many)
{
  "installed_packages_one": "{{count}} пакет установлен",
  "installed_packages_few": "{{count}} пакета установлено",
  "installed_packages_many": "{{count}} пакетов установлено"
}

// locales/ar.json (Arabic has 6 plural forms)
{
  "installed_packages_zero": "لا توجد حزم مثبتة",
  "installed_packages_one": "حزمة واحدة مثبتة",
  "installed_packages_two": "حزمتان مثبتتان",
  "installed_packages_few": "{{count}} حزم مثبتة",
  "installed_packages_many": "{{count}} حزمة مثبتة",
  "installed_packages_other": "{{count}} حزمة مثبتة"
}
```

Languages with complex plural rules (Arabic with 6 forms, Russian and Polish with 3 forms, Welsh with 5 forms) are fully supported by i18next's CLDR data. Translators must provide all the plural forms their language requires; the extraction script warns if a plural key is missing.

## 8. Variables

Variables are interpolated via i18next's standard `{{var}}` syntax:

```typescript
t('package_installed', { name: 'cline', version: '1.2.0' });
// en: "Installed cline@1.2.0"
// es: "Instalado cline@1.2.0"
// ja: "cline@1.2.0 をインストールしました"

// locales/en.json
{
  "package_installed": "Installed {{name}}@{{version}}"
}
```

Variables are clearly marked in translation files (the `{{...}}` is visually distinct from prose), and translators must preserve them. The extraction script's review step (see §10) catches accidental variable deletion or renaming — a PR that drops a `{{name}}` from a translation fails CI with `E_I18N_VARIABLE_MISSING`.

## 9. RTL Support

Arabic and Hebrew are written right-to-left (RTL). Linuxify's CLI output adapts to RTL locales:

- **Text direction**: in RTL locales, the doctor table's columns are reversed (rightmost column first). Tables use the `direction: 'rtl'` rendering hint when the active locale is RTL.
- **Alignment**: padding aligns to the right in RTL. The `✔`/`✖`/`⚠` status icons appear on the right instead of the left.
- **Mixed content**: numbers, file paths, and code snippets remain LTR even in RTL output (per the [Unicode Bidirectional Algorithm](https://www.w3.org/International/articles/inline-bidi-markup/)). i18next's RTL support handles this automatically; developers do not need to mark individual strings.
- **Tested with sample RTL strings**: the test suite includes RTL fixture strings (Arabic, Hebrew) and verifies that table rendering, padding, and alignment produce correct output. The pseudo-locale test (see §13) catches layout regressions.

The CLI's interactive prompts (y/n, multiple choice) are not direction-sensitive and render identically in LTR and RTL locales.

## 10. Quality

Translation quality is enforced by review and automated checks.

- **Translations are reviewed by native speakers before merge.** For languages with a designated maintainer (see §14), the maintainer reviews. For languages without a maintainer, the project waits for a second native speaker to review before merging.
- **Automated checks** (CI):
  - **Missing keys**: every key in `en.json` must exist in every shipped locale file. Missing keys fail CI.
  - **Extra keys**: every key in a locale file must exist in `en.json`. Extra keys (typo, renamed key left behind) fail CI.
  - **Format string mismatches**: every `{{var}}` in `en.json` must appear in the translation, with the same name. Missing or renamed variables fail CI.
  - **Plural completeness**: if `en.json` declares `key_one` and `key_other`, every locale must declare all plural forms its language requires (per CLDR). Missing plural forms fail CI.
- **Translators are credited** in `CONTRIBUTORS.md` (a `## Translators` section listing each translator and their language) and in the release notes for the version that includes their work. Credit is important; translation is unpaid labour and the project takes it seriously.

## 11. Documentation Translation

Documentation in `docs/` is English-only for v1. Translating documentation is a much larger effort than translating CLI strings (the docs are ~100 pages), and the project does not have the translator capacity to keep up with doc changes.

What the project does support:

- **Community-translated docs**: anyone can fork the repo, translate the docs, and host the translation on their own site. The project links to community translations from the README once they reach a quality threshold (reviewed by a native speaker).
- **Official translations**: the top 5 languages by user count (TBD based on v1 telemetry — likely Spanish, Portuguese, Chinese, Japanese, and either French or Hindi) will get official translations post-v1.0, maintained by a paid translator for the first year (funded by Open Collective donations) and transitioned to community maintenance once a stable contributor base emerges.
- **Translation memory**: the project uses a translation memory (via Weblate, once integrated) so that strings translated in the CLI can be reused in docs, reducing the per-word translation cost.

## 12. Locale-Specific Behavior

Beyond string translation, some behaviour is locale-specific:

- **Date formatting**: `linuxify doctor` prints the current date in the header. In `en` locale: `2025-01-15 14:32 UTC`. In `de` locale: `15.01.2025 14:32 UTC`. In `ja` locale: `2025年01月15日 14:32 UTC`. Uses the `Intl.DateTimeFormat` API with the active locale.
- **Number formatting**: file sizes in `linuxify doctor` are locale-aware: `11.8 GB` in `en`, `11,8 GB` in `de` (comma decimal separator), `11.8 جيجابايت` in `ar`. Uses `Intl.NumberFormat`.
- **Sort order**: `linuxify list` sorts packages alphabetically. The sort order is locale-aware — in `de`, `ä` sorts as `ae`; in `sv`, `ä` sorts after `z`; in `ja`, packages are sorted by their kana reading. Uses `Intl.Collator` with the active locale.

These locale-aware behaviours are automatic via the `Intl` APIs; developers do not need to do anything special beyond setting the locale in `i18next.init()`. The trade-off is that the `Intl` APIs require full ICU data, which adds ~10 MB to the Node.js runtime. Linuxify bundles full ICU by default; users who want to strip it for size can do so via a build flag, but locale-aware formatting will fall back to English.

## 13. Testing

i18n is tested at three levels:

- **Unit tests verify all `t()` calls have keys in `en.json`.** A custom ESLint rule (`linuxify/i18n-key-exists`) flags any `t('key')` call where `key` does not exist in `locales/en.json`. This catches typos at lint time, before runtime.
- **Tests run with `LANG=fr_FR.UTF-8`** in a subset of the CI matrix, to verify that fallback works (if a key is missing from `fr.json`, the English string is used, not an error). This catches "I forgot to add the French translation" regressions.
- **Pseudo-locale test (`qq`)**: a synthetic locale where every string is padded with brackets and accented characters (e.g., `"[__Storage__]"` instead of `"Storage"`). The pseudo-locale test runs the full CLI with `LINUXIFY_PSEUDO_LOCALE=qq` and verifies that no strings are untranslatable (hardcoded English), no layout breaks (the padding simulates the 30% text expansion typical of translations), and no variable interpolation breaks. The pseudo-locale is a developer tool — it is not shipped — but it is invaluable for catching i18n bugs early.

```bash
# Run the pseudo-locale test
LINUXIFY_PSEUDO_LOCALE=qq npm test -- --filter i18n
```

## 14. Initial Languages

v1 ships with translations for 9 languages, chosen by estimated user count in the target markets (developers using Android phones for coding):

| Code | Language | Native Name | Estimated Users |
|---|---|---|---|
| `en` | English | English | (default, source) |
| `es` | Spanish | Español | ~15% |
| `fr` | French | Français | ~8% |
| `de` | German | Deutsch | ~6% |
| `pt-BR` | Brazilian Portuguese | Português brasileiro | ~12% |
| `ja` | Japanese | 日本語 | ~7% |
| `zh-CN` | Simplified Chinese | 简体中文 | ~18% |
| `ar` | Arabic | العربية | ~5% |
| `hi` | Hindi | हिन्दी | ~10% |

These 9 cover an estimated ~80% of the target user base. Additional languages are added as community members contribute translations. Each language has a designated maintainer (or co-maintainers) listed in `CONTRIBUTORS.md`; the maintainer is responsible for keeping the translation up to date as new strings land in `en.json`.

If your language is not on this list and you want to translate it, you are welcome to. Open a PR with `locales/<your-lang>.json` and mention `@linuxify/i18n`. The project will work with you to find a co-maintainer (so the translation does not become stale when you get busy) before merging.

## 15. Right to Refuse

Maintainers can refuse translation PRs that:

- **Are machine-translated without human review.** Google Translate and DeepL produce plausible-looking but subtly wrong translations, especially for technical terms and for languages with complex grammar (Russian plurals, Arabic agreement). A PR that is clearly machine-translated (no human-touched phrasing, no technical-term handling) will be rejected with a request for human review.
- **Contain offensive content.** Slurs, political statements, or anything that violates the [Code of Conduct](../../CODE_OF_CONDUCT.md) in translation. This has not happened yet, but the policy is explicit.
- **Do not follow the style guide.** The Linuxify Translation Style Guide (in `docs/16-community/translation-style-guide.md`, to be written) covers tone (informal vs. formal address per language), technical-term handling (which terms stay English, which are translated), and punctuation conventions. A PR that ignores the style guide is asked to revise.
- **Are for languages without a maintainer.** If no one is willing to maintain the translation (keep it up to date as `en.json` changes), the translation will become stale and mislead users. The project prefers to not ship a translation at all than to ship a stale one. If you want to translate a new language, you are also volunteering to maintain it (or to find a co-maintainer); the maintainers will discuss this with you before merging.

The refusal criteria are about quality and sustainability, not gatekeeping. The project genuinely wants more translations; it also wants translations that do not rot. If your PR is refused, the maintainer will explain why and offer to help you revise. Most refused PRs are merged after one round of revision.
