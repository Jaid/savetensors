import {expect, test} from 'bun:test'

import makeCli from '#src/makeCli.ts'

test('makeCli constructs without crashing', () => {
  expect(makeCli(['--help'])).toBeFunction()
})
