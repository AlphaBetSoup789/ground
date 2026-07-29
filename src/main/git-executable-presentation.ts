import type { MessageBoxOptions } from 'electron'
import type { GitExecutableBinding } from './git-executable-discovery'

const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u

function reviewedText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      if (
        codePoint === undefined ||
        (codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          !BIDI_CONTROL_PATTERN.test(character))
      ) {
        return character
      }
      return `\\u{${codePoint.toString(16).padStart(4, '0')}}`
    })
    .join('')
}

export function gitExecutableConfirmationOptions(
  binding: GitExecutableBinding
): MessageBoxOptions {
  return {
    type: 'warning',
    buttons: ['Cancel', 'Use this Git'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Choose Git executable',
    message: 'Trust this exact Git executable?',
    detail: [
      `Canonical path: ${reviewedText(binding.path)}`,
      `SHA-256: ${binding.sha256}`,
      `Size: ${binding.size} bytes`,
      `Identity fingerprint: ${binding.fingerprint}`,
      '',
      'After approval, Ground will run only this executable with --version and require Git 2.23 or newer.',
      'Ground saves the path and fingerprint as a preference, not as permanent authority. It revalidates the exact file identity before every Git process launch and stops if it changes.'
    ].join('\n')
  }
}
