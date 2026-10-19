'use strict';

// Shared lint baseline for the Postal Systems / Nodemailer packages, in the CommonJS form of
// ../nodemailer/eslint.config.js: the same rule set, with formatting left to Prettier.
// Keep this file identical to that one in substance, except for the "Repo-specific" block.

const { defineConfig } = require('eslint/config');
const prettier = require('eslint-config-prettier');
const globals = require('globals');
const tseslint = require('typescript-eslint');

const unusedVarsOptions = {
    varsIgnorePattern: '^_',
    argsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_'
};

module.exports = defineConfig([
    {
        ignores: [
            'node_modules/**',
            'coverage/**',
            'dist/**',
            '.build-test/**',
            'data/**',
            'tools/client-capture/node_modules/**',
            'tools/client-capture/.state/**'
        ]
    },
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.ts'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: Object.assign({}, globals.node, globals.es2022)
        },
        rules: {
            // Error detection
            'for-direction': 'error',
            'no-await-in-loop': 'error',
            'no-div-regex': 'error',
            eqeqeq: 'error',
            'dot-notation': 'error',
            curly: 'error',
            'no-fallthrough': 'error',
            'no-unused-expressions': [
                'error',
                {
                    allowShortCircuit: true
                }
            ],
            'no-unused-vars': ['error', unusedVarsOptions],
            'handle-callback-err': 'error',
            'no-new': 'error',
            'new-cap': 'error',
            'no-eval': 'error',
            'no-invalid-this': 'error',
            radix: ['error', 'always'],
            'no-use-before-define': ['error', 'nofunc'],
            'callback-return': ['error', ['callback', 'cb', 'done']],
            'no-regex-spaces': 'error',
            'no-empty': 'error',
            'no-duplicate-case': 'error',
            'no-empty-character-class': 'error',
            'no-redeclare': 'off', // Disabled per project preference
            'block-scoped-var': 'error',
            'no-sequences': 'error',
            'no-throw-literal': 'error',
            'no-useless-call': 'error',
            'no-useless-concat': 'error',
            'no-void': 'error',
            yoda: 'error',
            'no-undef': 'error',
            'no-var': 'error',
            'no-bitwise': 'error',
            'no-lonely-if': 'error',
            'no-mixed-spaces-and-tabs': 'error',
            'arrow-body-style': ['error', 'as-needed'],
            'arrow-parens': ['error', 'as-needed'],
            'prefer-arrow-callback': 'error',
            'object-shorthand': 'error',
            'prefer-spread': 'error',
            'no-prototype-builtins': 'off', // Disabled per project preference
            strict: ['error', 'global']
        }
    },
    {
        // "type": "commonjs": plain JavaScript files here are CommonJS, unlike nodemailer's
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: {
            sourceType: 'commonjs'
        }
    },
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.recommended],
        rules: {
            // Handled by the TypeScript compiler
            'no-undef': 'off',
            // TypeScript-aware replacements for the base rules
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
            'no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-expressions': [
                'error',
                {
                    allowShortCircuit: true
                }
            ],
            'no-use-before-define': 'off',
            '@typescript-eslint/no-use-before-define': [
                'error',
                {
                    functions: false,
                    classes: true,
                    variables: true,
                    typedefs: false,
                    ignoreTypeReferences: true
                }
            ],
            'no-invalid-this': 'off',
            '@typescript-eslint/no-invalid-this': 'error',
            // Project preferences
            'prefer-const': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-namespace': 'off'
        }
    },
    // Repo-specific: overrides go here, each with a one-line reason
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.ts'],
        rules: {
            // Sequential awaits are deliberate (CLI batches, retries, ordered fixtures): 113 sites
            'no-await-in-loop': 'off',
            // FNV/murmur-style hashing and shingle mixing are bitwise by definition: 31 sites
            'no-bitwise': 'off',
            // `void promise` marks a deliberately unawaited promise: 3 sites
            'no-void': ['error', { allowAsStatement: true }]
        }
    },
    {
        files: ['**/*.ts'],
        rules: {
            // Kept from this repo's earlier config: type-only imports stay erasable in the CommonJS output
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }]
        }
    },
    {
        // The capture harness passes functions to Playwright's page.evaluate(), which run in the browser
        files: ['tools/client-capture/**'],
        languageOptions: {
            globals: Object.assign({}, globals.node, globals.browser)
        }
    },
    prettier
]);
