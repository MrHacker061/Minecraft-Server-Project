import { describe, expect, it } from 'vitest'
import { parseJavaMajorVersion } from '../src/main/services/java'

describe('parseJavaMajorVersion', () => {
  it('parses current Oracle Java output', () => {
    expect(parseJavaMajorVersion('java version "25.0.1" 2025-10-21 LTS')).toBe(25)
  })

  it('parses OpenJDK output', () => {
    expect(parseJavaMajorVersion('openjdk version "21.0.4" 2024-07-16')).toBe(21)
  })

  it('parses legacy Java 8 output', () => {
    expect(parseJavaMajorVersion('java version "1.8.0_401"')).toBe(8)
  })

  it('rejects unrelated output', () => {
    expect(parseJavaMajorVersion('not a java runtime')).toBeNull()
  })
})
