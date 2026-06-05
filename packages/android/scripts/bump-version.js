#!/usr/bin/env node
/**
 * Single-source version bump across the four places a Convert-X release
 * version lives, so they never drift. The in-app updater compares
 * package.json's version against the installed build.gradle versionName — if
 * those disagree the updater offers phantom updates or hides real ones.
 *
 *   1. package.json              "version"
 *   2. app.json                  expo.version
 *   3. android/app/build.gradle  versionName
 *   4. android/app/build.gradle  versionCode  (auto-incremented)
 *
 * Usage:
 *   node scripts/bump-version.js <newVersion>        # e.g. 0.6.20
 *   node scripts/bump-version.js patch|minor|major
 *
 * (npm alias: `npm run bump -- patch`)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const appJsonPath = path.join(ROOT, 'app.json');
const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');

function bumpSemver(version, kind) {
  const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10) || 0);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/bump-version.js <newVersion|patch|minor|major>');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next = ['patch', 'minor', 'major'].includes(arg) ? bumpSemver(current, arg) : arg;

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Invalid version: "${next}" (expected MAJOR.MINOR.PATCH)`);
  process.exit(1);
}

// 1. package.json
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 2. app.json
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
appJson.expo.version = next;
fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');

// 3 + 4. build.gradle versionName + auto-incremented versionCode
let gradle = fs.readFileSync(gradlePath, 'utf8');
const codeMatch = gradle.match(/versionCode\s+(\d+)/);
if (!codeMatch) {
  console.error('Could not find versionCode in build.gradle');
  process.exit(1);
}
const nextCode = parseInt(codeMatch[1], 10) + 1;
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${nextCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${next}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`Bumped ${current} -> ${next}  (versionCode ${codeMatch[1]} -> ${nextCode})`);
console.log('Updated: package.json, app.json, android/app/build.gradle');
