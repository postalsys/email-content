'use strict';

/**
 * Same as copy-assets.js, for the test build output tree (.build-test/src/...).
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [
    { from: 'src/detect/patterns', to: '.build-test/src/detect/patterns', ext: '.json' },
    { from: 'src/review/public', to: '.build-test/src/review/public', ext: null }
];

for (const target of targets) {
    const fromDir = path.join(root, target.from);
    const toDir = path.join(root, target.to);
    if (!fs.existsSync(fromDir)) {
        continue;
    }
    fs.mkdirSync(toDir, { recursive: true });
    for (const name of fs.readdirSync(fromDir)) {
        if (target.ext && !name.endsWith(target.ext)) {
            continue;
        }
        const source = path.join(fromDir, name);
        if (!fs.statSync(source).isFile()) {
            continue;
        }
        fs.copyFileSync(source, path.join(toDir, name));
    }
}
