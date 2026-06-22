import {expect, test} from 'bun:test'

const {default: savetensors} = await import('#src/main.ts')

test('should run', () => {
  const result = savetensors()
  expect(result).toBe('savetensors') // TODO Test actual functionality
})
