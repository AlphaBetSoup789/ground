import { describe, expect, it } from 'vitest'
import {
  parsePackagedSmokeArgument,
  parsePackagedSmokePreloadToken
} from './packaged-smoke'

const TOKEN = '0123456789abcdef0123456789abcdef'

describe('packaged smoke arguments', () => {
  it('accepts one bounded launch or native request', () => {
    expect(
      parsePackagedSmokeArgument([
        '/path/to/Ground',
        `--ground-packaged-smoke=${TOKEN}:launch`
      ])
    ).toEqual({ token: TOKEN, scope: 'launch' })
    expect(
      parsePackagedSmokeArgument([
        `--ground-packaged-smoke=${TOKEN}:native`
      ])
    ).toEqual({ token: TOKEN, scope: 'native' })
  })

  it('rejects malformed, unknown, or duplicate smoke requests', () => {
    expect(
      parsePackagedSmokeArgument(['--ground-packaged-smoke=../result:native'])
    ).toBeUndefined()
    expect(
      parsePackagedSmokeArgument([
        `--ground-packaged-smoke=${TOKEN}:unknown`
      ])
    ).toBeUndefined()
    expect(
      parsePackagedSmokeArgument([
        `--ground-packaged-smoke=${TOKEN}:launch`,
        `--ground-packaged-smoke=${TOKEN}:launch`
      ])
    ).toBeUndefined()
  })

  it('accepts only one exact preload token', () => {
    expect(
      parsePackagedSmokePreloadToken([
        `--ground-packaged-smoke-preload=${TOKEN}`
      ])
    ).toBe(TOKEN)
    expect(
      parsePackagedSmokePreloadToken([
        '--ground-packaged-smoke-preload=not-a-token'
      ])
    ).toBeUndefined()
    expect(
      parsePackagedSmokePreloadToken([
        `--ground-packaged-smoke-preload=${TOKEN}`,
        `--ground-packaged-smoke-preload=${TOKEN}`
      ])
    ).toBeUndefined()
  })
})
