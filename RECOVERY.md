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
- So the keystore **must** be backed up somewhere you can actually retrieve it.

### Where the keystore lives on the current PC
- Keystore file: `C:/Users/cedri/keys/convert-x-android-release.jks`
- Password file: `C:/Users/cedri/keys/convert-x-android-release.password.txt`
  (a single 32-char password used for **both** the store and the key)
- Key alias: `convert-x-release`

### Backup location (FILL IN once set up — do this before wiping!)
- [ ] Backed up to: ________________________
      (e.g. a PRIVATE repo `CedrickGD/convert-x-keys`, or Google Drive, or a password manager)

### Restoring on a new PC
1. Put the keystore + password back into a folder **outside any repo**
   (e.g. `C:/Users/<you>/keys/`).
2. For local signed builds only: copy `packages/android/android/gradle.properties.example`
   to `packages/android/android/gradle.properties.local`, point
   `CONVERT_X_KEYSTORE_FILE` at the keystore path, and fill in the password + alias.
3. CI needs nothing else — the GitHub secrets are already set. Pushing a `v*` tag
   builds and publishes a signed APK.

## Everything else IS on GitHub

| Asset | Where | Notes |
|---|---|---|
| Desktop + web + android + shared source | `CedrickGD/Convert-X` | ⚠️ ensure the `chore/consolidate-monorepo` branch is **pushed** before wiping |
| Released APKs | `CedrickGD/Convert-X-Android-APK` | also where the in-app updater pulls from |
| `_consolidation_backups/*.bundle` (local) | this PC only | throwaway — the originals are already on GitHub |

## Before you wipe this PC — checklist
- [ ] `git push` the `chore/consolidate-monorepo` branch (+ any other unpushed branches)
- [ ] Keystore + password backed up somewhere retrievable (see above)
- [ ] Each of your OTHER repos in this folder has a GitHub remote and is pushed
