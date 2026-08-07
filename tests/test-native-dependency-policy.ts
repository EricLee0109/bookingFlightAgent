import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
) as {
  packageManager?: string;
};
const workspaceConfig = fs.readFileSync(
  path.join(projectRoot, 'pnpm-workspace.yaml'),
  'utf8',
);

assert.equal(
  packageJson.packageManager,
  'pnpm@10.27.0',
  'Pin pnpm so Windows and Linux use the same dependency-install behavior.',
);
assert.match(
  workspaceConfig,
  /^allowBuilds:\s*$/m,
  'Native dependency build scripts must use an explicit allow-list.',
);
assert.match(
  workspaceConfig,
  /^\s+better-sqlite3:\s+true\s*$/m,
  'better-sqlite3 must be allowed to install its platform-native binding.',
);
assert.doesNotMatch(
  workspaceConfig,
  /^ignoredBuiltDependencies:\s*$/m,
  'Do not ignore better-sqlite3 builds; fresh Linux clones need the native binding.',
);

console.log('Native dependency policy tests passed.');
