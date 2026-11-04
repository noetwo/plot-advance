import globals from 'globals';

const splitDefectRules = {
    'no-undef': 'error',
    'no-unused-vars': ['warn', {
        args: 'none',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
    }],
    'no-import-assign': 'error',
};

const hostGlobals = {
    $: 'readonly',
    jQuery: 'readonly',
    SillyTavern: 'readonly',
    toastr: 'readonly',
};

export default [
    {
        ignores: ['node_modules/**'],
    },
    {
        files: ['index.js', 'src/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...hostGlobals,
            },
        },
        rules: splitDefectRules,
    },
    {
        files: ['tests/**/*.mjs'],
        languageOptions: {
            globals: globals.node,
        },
        rules: splitDefectRules,
    },
];
