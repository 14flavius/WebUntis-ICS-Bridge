// Per-field hints: credential fields must remain available to password managers.
// Extensions may override these hints according to their own settings.
export const nonCredentialAutofill = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-protonpass-ignore': 'true',
};
