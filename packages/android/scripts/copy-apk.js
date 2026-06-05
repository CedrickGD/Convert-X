#!/usr/bin/env node
/**
 * After `./gradlew assembleRelease`, copy the signed APK to
 * `./release/Convert-X-Android-<version>.apk` so it's easy to grab.
 *
 * The release build is ABI-split (see android/app/build.gradle → splits.abi),
 * so Gradle emits `app-<abi>-release.apk` (e.g. `app-arm64-v8a-release.apk`),
 * NOT `app-release.apk`. Prefer arm64-v8a, then any other ABI, then a
 * universal `app-release.apk` if a future build re-enables universalApk.
 *
 * Idempotent. Creates `release/` if missing. Errors loudly if no APK is found.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const releaseOutDir = path.join(
  ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release'
);

function resolveApk() {
  // Preference order: arm64 (our shipped ABI), then other splits, then a
  // universal fallback.
  const preferred = [
    'app-arm64-v8a-release.apk',
    'app-armeabi-v7a-release.apk',
    'app-x86_64-release.apk',
    'app-release.apk',
  ];
  for (const name of preferred) {
    const p = path.join(releaseOutDir, name);
    if (fs.existsSync(p)) return p;
  }
  // Last resort: any .apk in the release output dir.
  if (fs.existsSync(releaseOutDir)) {
    const apk = fs.readdirSync(releaseOutDir).find((f) => f.endsWith('.apk'));
    if (apk) return path.join(releaseOutDir, apk);
  }
  return null;
}

const apkPath = resolveApk();
const releaseDir = path.join(ROOT, 'release');
const destName = `Convert-X-Android-${pkg.version}.apk`;
const destPath = path.join(releaseDir, destName);

if (!apkPath) {
  console.error(`No release APK found in ${releaseOutDir}`);
  console.error('Did `./gradlew assembleRelease` succeed?');
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

fs.copyFileSync(apkPath, destPath);

const sizeMb = (fs.statSync(destPath).size / (1024 * 1024)).toFixed(1);
console.log(`Copied ${path.basename(apkPath)} -> release/${destName} (${sizeMb} MB)`);
