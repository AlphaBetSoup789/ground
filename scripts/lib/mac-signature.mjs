export function classifyUnsignedMacSignature(status, output) {
  if (
    typeof output !== 'string' ||
    output.includes('Authority=Developer ID Application')
  ) {
    return undefined
  }
  if (status !== 0 && /code object is not signed at all/iu.test(output)) {
    return 'completely-unsigned'
  }
  if (
    status === 0 &&
    output.includes('Signature=adhoc') &&
    output.includes('TeamIdentifier=not set')
  ) {
    return 'adhoc-teamless'
  }
  return undefined
}
