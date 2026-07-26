'use strict';

/**
 * Copy non TypeScript assets into the build output.
 *
 * tsc only emits JavaScript, so pattern JSON files and the review app's static assets need copying.
 * Keeping them as real files rather than inlining them into modules is what makes them overridable
 * at runtime.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const targets = [
    { from: 'src/detect/patterns', to: 'dist/detect/patterns', ext: '.json' },
    { from: 'src/review/public', to: 'dist/review/public', ext: null }
];

let copied = 0;
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
        copied++;
    }
}

process.stderr.write(`copied ${copied} asset file(s)\n`);
