#!/usr/bin/env node
/**
 * After `./gradlew assembleRelease`, copy the signed APK to
 * `./release/Convert-X-Android-<version>.apk` so it's easy to grab.
 *
 * Idempotent. Creates `release/` if missing. Errors loudly if the APK
 * isn't where we expect it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const apkPath = path.join(
  ROOT,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
);
const releaseDir = path.join(ROOT, 'release');
const destName = `Convert-X-Android-${pkg.version}.apk`;
const destPath = path.join(releaseDir, destName);

if (!fs.existsSync(apkPath)) {
  console.error(`No APK at ${apkPath}`);
  console.error('Did `./gradlew assembleRelease` succeed?');
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

fs.copyFileSync(apkPath, destPath);

const sizeMb = (fs.statSync(destPath).size / (1024 * 1024)).toFixed(1);
console.log(`Copied APK -> release/${destName} (${sizeMb} MB)`);
