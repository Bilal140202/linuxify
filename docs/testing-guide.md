# Deep-Dive Testing Guide: Baby Steps

> **Goal:** Verify Linuxify works end-to-end on a real Android device.
> **Audience:** Alpha testers and maintainers.
> **Method:** Small, verifiable steps. After each step, check the expected
> output before moving to the next. If something fails, stop and report.

This guide is designed to catch bugs early — at each step, you verify one
thing. If step 3 fails, you don't need to run steps 4-10 to know there's a
problem. This makes bug reports precise and actionable.

---

## Before You Start

### What you need

- An Android phone (13, 14, 15, or 16)
- Termux installed from **F-Droid** (NOT Google Play)
- ~2 GB free storage
- Wi-Fi or mobile data connection
- 15-30 minutes

### What you DON'T need

- Root access
- A specific phone manufacturer (Pixel, Samsung, Motorola, Xiaomi all work)
- Any prior Linux knowledge

---

## Phase 1: Clean Slate (5 minutes)

### Step 1.1: Update Termux

```bash
pkg update && pkg upgrade -y
```

**Expected:** Packages update successfully. No errors.

**If it fails:** Run `termux-change-repo` and try again. If still failing,
your Termux might be from Play Store — reinstall from F-Droid.

**Verify:**
```bash
pkg --version 2>&1 || dpkg -s com.termux | grep Version
```
You should see a version number ≥ 0.118.

---

### Step 1.2: Install prerequisites

```bash
pkg install -y git nodejs
```

**Expected:** `git` and `nodejs` install without errors.

**Verify:**
```bash
node --version   # should print v20.x or newer
git --version    # should print git version 2.x
```

---

### Step 1.3: Clone Linuxify

```bash
cd ~
git clone https://github.com/Bilal140202/linuxify.git
cd linuxify
```

**Expected:** Repository clones successfully.

**Verify:**
```bash
ls package.json src/ docs/
```
You should see `package.json`, the `src/` directory, and the `docs/` directory.

---

### Step 1.4: Install dependencies

```bash
npm install
```

**Expected:** Installs ~430 packages in 15-30 seconds. No errors.

**⚠️ Critical check:** This must succeed WITHOUT `--legacy-peer-deps`. If you
see `ERESOLVE could not resolve`, that's a bug — report it.

**If it fails with peer dependency errors:**
```bash
npm install --legacy-peer-deps  # workaround
```
Then report the error — include the full `npm error` output.

---

### Step 1.5: Build the CLI

```bash
npm run build
```

**Expected:** Builds in ~5-15 seconds. Output ends with `⚡️ Build success`.

**Verify:**
```bash
node dist/cli/index.js --version
```
Should print `0.1.0-alpha.1` (or similar version string).

---

### Step 1.6: Link the CLI

```bash
npm link
```

**Expected:** Creates a `linuxify` command on your PATH.

**Verify:**
```bash
which linuxify
linuxify --version
```
`which linuxify` should print a path. `linuxify --version` should print the
version.

**If `linuxify` is not found:** Run `source ~/.bashrc` (or open a new Termux
session), then try again.

---

### ✅ Phase 1 Complete

You should now be able to run `linuxify --help` and see the full command list.
If any step in Phase 1 failed, stop here and report the issue — there's no
point testing further until the basics work.

---

## Phase 2: First Diagnosis (2 minutes)

### Step 2.1: Run doctor

```bash
linuxify doctor
```

**Expected:** A formatted report with check marks (✔/✖/⚠). On a fresh install,
you'll see several ✖ failures — that's normal, we haven't bootstrapped yet.

**What to look for:**
- ✔ Termux (or ⚠ if version can't be determined)
- ✔ Android (with your version number)
- ✔ Architecture (aarch64)
- ✔ Storage (>2 GB free)
- ✖ Bootstrap incomplete (expected — we haven't run init yet)
- ✖ Distro not installed (expected)
- ✖ PATH not configured (expected)

**If doctor crashes:** Report the full error output. Include `linuxify report --json`.

---

### Step 2.2: Run doctor with explanations

```bash
linuxify doctor --explain
```

**Expected:** For each failing check, shows:
- What this checks
- Why it matters
- If not fixed (concrete consequence)
- Recommended fix

**Verify:** The explanations are clear and written in plain English. If any
explanation is missing or confusing, note it.

---

### Step 2.3: Generate a report

```bash
linuxify report --markdown
```

**Expected:** A fenced code block with your environment summary.

**Verify:**
- Your Android version is correct
- Your architecture is correct
- The report says "Copy this report when opening a GitHub issue"
- No home directory paths or API keys appear in the output

---

### Step 2.4: Generate a fingerprint

```bash
linuxify report --fingerprint
```

**Expected:** A single line like:
```
linuxify/0.1.0-alpha.1 android/16 termux/0.119 arch/aarch64 kernel/6.1 storage/ok doctor/5fail
```

**Verify:** The fingerprint is one line, no newline in the middle.

---

### ✅ Phase 2 Complete

You now have a baseline. Doctor works, report works, fingerprint works. Save
the fingerprint — if you file a bug later, include it.

---

## Phase 3: Bootstrap (10-15 minutes)

This is the big one. Bootstrap downloads Ubuntu, installs Node/Python, and
wires up your PATH. It takes 5-15 minutes depending on your network.

### Step 3.1: Dry-run the repair plan

```bash
linuxify repair --dry-run
```

**Expected:** Shows a phased repair plan:
```
1. Bootstrap → linuxify init
2. Environment → pkg install termux (or similar)
3. PATH → linuxify repair paths
Total: N step(s) across M phase(s).
Dry run — no changes made.
```

**Verify:** The plan makes sense. No commands reference non-existent options
like `--resume`. No duplicate commands.

---

### Step 3.2: Run bootstrap

```bash
linuxify init
```

**Expected:** Runs through 9 stages (preflight → host deps → rootfs →
first-boot → runtimes → home → PATH → verify → tips). Each stage prints
progress. Total time: 5-15 minutes.

**What to watch for:**
- Stage 0 (preflight): Should pass — we already verified Termux/Android/arch
- Stage 1 (host deps): `pkg install proot proot-distro jq curl...`
- Stage 2 (rootfs): Downloads Ubuntu 24.04 rootfs (~300 MB). **This is the
  slowest stage.** If it fails, check your network.
- Stage 3 (first-boot apt): `apt update && apt install build-essential...`
- Stage 4 (runtimes): Installs Node LTS + Python 3.12
- Stage 5 (home setup): Creates `~/.linuxify/` directory tree
- Stage 6 (PATH): Adds `~/.linuxify/bin` to your shell rc files
- Stage 7 (verify): Runs doctor internally
- Stage 8 (tips): Prints welcome message

**If a stage fails:**
1. Note the stage number and error message
2. Run `linuxify report --markdown` to capture the state
3. Run `linuxify doctor --explain` to understand what's broken
4. Report the issue with the report + doctor output + the exact error

**If bootstrap hangs:**
- Stage 2 (rootfs download) can take 5+ minutes on slow networks. Wait.
- Stage 3 (apt install) can take 3+ minutes. Wait.
- If it hangs for >10 minutes with no output, Ctrl-C and report.

---

### Step 3.3: Verify bootstrap completed

```bash
linuxify doctor
```

**Expected:** All checks should pass now:
- ✔ Bootstrap completed (9/9 stages)
- ✔ Distro installed (Ubuntu 24.04)
- ✔ Runtime: Node.js (v22 or v24)
- ✔ Runtime: Python (3.12)
- ✔ PATH: linuxify/bin
- ✔ PATH: proot

**If any check still fails:**
```bash
linuxify doctor --explain
```
Read the explanation, then try:
```bash
linuxify repair
```

---

### Step 3.4: Test the shell

```bash
linuxify shell
```

**Expected:** Enters an interactive Ubuntu shell. The prompt changes to
something like `linuxify@localhost:~$`.

**Verify inside the shell:**
```bash
node --version
python3 --version
git --version
exit
```

**If `linuxify shell` fails:** Check that `linuxify doctor` shows ✔ for
distro.installed and path.proot. If not, bootstrap didn't complete.

---

### ✅ Phase 3 Complete

You now have a working Linuxify environment with Ubuntu, Node, Python, and
PATH all configured. This is the milestone — everything else is gravy.

---

## Phase 4: Install a Package (3 minutes)

### Step 4.1: Install Cline

```bash
linuxify add cline
```

**Expected:**
1. Fetches `cline.yml` from the registry
2. Installs Node if not already present (should already be there)
3. Runs `npm install -g cline` inside proot
4. Applies platform patches (regex patches to make `process.platform` work)
5. Creates a launcher at `~/.linuxify/bin/cline`
6. Prints success message

**Verify:**
```bash
linuxify list
```
Should show `cline` in the list.

```bash
which cline
```
Should print `~/.linuxify/bin/cline` (or similar).

---

### Step 4.2: Run Cline

```bash
cline --version
```

**Expected:** Prints Cline's version number. No "Unsupported platform" error.

**If it fails with `Unsupported platform: android-arm64`:**
```bash
linuxify patch cline
cline --version
```
The patch re-applies the platform fix.

**If it fails with `command not found`:**
```bash
source ~/.bashrc
cline --version
```
PATH wasn't reloaded after install.

---

### Step 4.3: Test the launcher

```bash
linuxify run cline --version
```

**Expected:** Same as `cline --version` — the launcher just wraps `linuxify run`.

---

### ✅ Phase 4 Complete

You can install and run Linux CLIs on Android. This is the core value
proposition of Linuxify.

---

## Phase 5: Break and Repair (5 minutes)

This phase tests the repair engine by intentionally breaking things.

### Step 5.1: Break PATH

```bash
# Remove ~/.linuxify/bin from PATH
export PATH=$(echo $PATH | tr ':' '\n' | grep -v linuxify/bin | paste -sd:)
linuxify doctor
```

**Expected:** `path.linuxify_bin` shows ✖.

**Repair:**
```bash
linuxify repair paths
source ~/.bashrc
linuxify doctor
```

**Expected:** `path.linuxify_bin` shows ✔ again.

---

### Step 5.2: Break state.json

```bash
mv ~/.linuxify/state.json ~/.linuxify/state.json.bak
linuxify doctor
```

**Expected:** Doctor still works (reads from marker files). May show warnings.

**Repair:**
```bash
linuxify repair --yes
linuxify doctor
```

**Expected:** State is rebuilt or repaired.

---

### Step 5.3: Test the repair plan

```bash
linuxify repair --dry-run
```

**Expected:** Shows a plan. No commands reference `--resume` or other
non-existent options. Commands are deduplicated.

---

### Step 5.4: Test interactive repair

```bash
linuxify repair
```

**Expected:**
1. Shows the repair plan
2. Prints `Proceed with repair? [y/N]`
3. **Waits for your input** (this is the bug we just fixed — it used to exit
   immediately)
4. If you press `y` + Enter: runs the repair
5. If you press `n` + Enter or just Enter: cancels

**⚠️ Critical:** The prompt must actually wait. If it exits immediately, that's
the bug we just fixed — report it.

---

### ✅ Phase 5 Complete

The repair engine works. You can break things and Linuxify can fix them.

---

## Phase 6: Final Report (2 minutes)

### Step 6.1: Generate the final report

```bash
linuxify report --markdown > ~/linuxify-test-report.md
```

**Expected:** A markdown file with your full environment summary.

### Step 6.2: Check the repair logs

```bash
ls ~/.linuxify/logs/repair-*.log
```

**Expected:** At least one repair log file from your testing.

**Verify:**
```bash
cat ~/.linuxify/logs/repair-*.log | tail -20
```

---

## Reporting Issues

If ANY step fails, report it with:

1. **The step number** (e.g., "Step 3.2 failed")
2. **The exact command** you ran
3. **The full output** (copy-paste, don't paraphrase)
4. **Your fingerprint:** `linuxify report --fingerprint`
5. **The repair log** (if a repair was involved): `~/.linuxify/logs/repair-*.log`

File issues at: https://github.com/Bilal140202/linuxify/issues

Use the bug report template — it will ask for `linuxify doctor --markdown`
output, which you can generate with:
```bash
linuxify doctor --markdown
```

---

## Testing Checklist

Print this and check off each step:

```
Phase 1: Clean Slate
[ ] 1.1  pkg update && pkg upgrade
[ ] 1.2  pkg install git nodejs
[ ] 1.3  git clone linuxify
[ ] 1.4  npm install (no --legacy-peer-deps)
[ ] 1.5  npm run build
[ ] 1.6  npm link && linuxify --version

Phase 2: First Diagnosis
[ ] 2.1  linuxify doctor
[ ] 2.2  linuxify doctor --explain
[ ] 2.3  linuxify report --markdown
[ ] 2.4  linuxify report --fingerprint

Phase 3: Bootstrap
[ ] 3.1  linuxify repair --dry-run
[ ] 3.2  linuxify init (5-15 min)
[ ] 3.3  linuxify doctor (all ✔)
[ ] 3.4  linuxify shell && node --version && exit

Phase 4: Install a Package
[ ] 4.1  linuxify add cline
[ ] 4.2  cline --version
[ ] 4.3  linuxify run cline --version

Phase 5: Break and Repair
[ ] 5.1  Break PATH, repair it
[ ] 5.2  Break state.json, repair it
[ ] 5.3  linuxify repair --dry-run
[ ] 5.4  linuxify repair (interactive prompt works)

Phase 6: Final Report
[ ] 6.1  linuxify report --markdown > report.md
[ ] 6.2  ls ~/.linuxify/logs/repair-*.log
```

When all boxes are checked, you have a working Linuxify installation. 🎉
