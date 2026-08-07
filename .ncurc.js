'use strict';

module.exports = {
    upgrade: true,
    reject: [
        // TypeScript 7 is the native port. It is a major compiler rewrite with its own
        // diagnostics and tsconfig behavior, so moving to it is a deliberate migration
        // rather than a dependency refresh. Stay on 5.x until that is done on purpose.
        'typescript'
    ]
};
