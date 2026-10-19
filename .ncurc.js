'use strict';

module.exports = {
    upgrade: true,
    target: name => {
        // TypeScript 7 is the native port. It is a major compiler rewrite with its own
        // diagnostics and tsconfig behavior, so moving to it is a deliberate migration
        // rather than a dependency refresh. Stay on 6.x until that is done on purpose.
        // 6.x needs "ignoreDeprecations": "6.0" in tsconfig.json for moduleResolution "node",
        // and builds output byte-identical to 5.9.3 with it.
        if (name === 'typescript') {
            return 'minor';
        }
        return 'latest';
    }
};
