import {makeEslintConfig} from 'eslint-config-jaid'

export default [
  {
    ignores: ['private/'],
  },
  ...makeEslintConfig(),
]
