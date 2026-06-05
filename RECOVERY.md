# Convert-X — recovery & backup notes

Read this first when setting up on a fresh PC, or **before wiping the current one**.

## ⚠️ The one thing GitHub does NOT back up for you: the Android signing key

The Android release **signing keystore** is the single irreplaceable asset in this
project. If it is lost you can never again ship an update that installs over an
existing install — every user would have to uninstall and reinstall from scratch.

- It is **NOT in this repo** (on purpose — a leaked signing key can't be revoked).
- It **is** stored as GitHub Actions secrets (`RELEASE_KEYSTORE_BASE64`,
  `RELEASE_KEYSTORE_PASSWORD`, `RELEASE_KEY_PASSWORD`, `RELEASE_KEY_ALIAS`) on both
  `CedrickGD/Convert-X` and `CedrickGD/Convert-X-Android-APK` — **but GitHub
  secrets are write-only: you cannot download them back.** They keep CI working;
  they are NOT a recovery path.

### ✅ Backup location (the place you CAN read the key back from)
The keystore + password are backed up in the **private** repo **`CedrickGD/keys`**,
in the `convert-x/` folder. Restore on a new PC with:

```bash
gh repo clone CedrickGD/keys
```

> Keep `CedrickGD/keys` **private**. Never make it public or share it.

### Where the keystore lives on the current PC
- Keystore file: `C:/Users/cedri/keys/convert-x-android-release.jks`
- Password file: `C:/Users/cedri/keys/convert-x-android-release.password.txt`
  (a single 32-char password used for **both** the store and the key)
- Key alias: `convert-x-release`

### Restoring on a new PC
1. `gh repo clone CedrickGD/keys`, then copy the two files from `convert-x/` into a
   folder **outside any code repo** (e.g. `C:/Users/<you>/keys/`).
2. For local signed builds only: copy `packages/android/android/gradle.properties.example`
   to `packages/android/android/gradle.properties.local`, point
   `CONVERT_X_KEYSTORE_FILE` at the keystore path, and fill in the password + alias.
3. CI needs nothing else — the GitHub secrets are already set. Pushing a `v*` tag
   builds and publishes a signed APK.

## Everything else IS on GitHub

| Asset | Where | Notes |
|---|---|---|
| Desktop + web + android + shared source | `CedrickGD/Convert-X` | on branch `chore/consolidate-monorepo` (pushed) |
| Released APKs | `CedrickGD/Convert-X` (this repo's Releases) | also where the in-app updater pulls from |
| Signing key backup | `CedrickGD/keys` (private) | the only place you can read the key back |
| `_consolidation_backups/*.bundle` (local) | this PC only | throwaway — the originals are already on GitHub |

## Before you wipe this PC — checklist
- [x] `git push` the `chore/consolidate-monorepo` branch (done) — also push any other unpushed branches
- [x] Keystore + password backed up to private repo `CedrickGD/keys` (done 2026-06-05)
- [ ] Confirm your OTHER repos in this folder each have a GitHub remote and are pushed
