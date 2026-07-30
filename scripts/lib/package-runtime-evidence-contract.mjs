export const REQUIRED_NATIVE_RUNTIME_CHECKS = Object.freeze([
  'main',
  'preload',
  'rendererDocument',
  'appIdentity',
  'safeStorage',
  'nativeApprovalDialog',
  'pty',
  'git',
  'providerCompatibleFirstTurn',
  'mcp',
  'mcpLaunchApproval',
  'processTreeCancellation'
])

export const PROVIDER_RUNTIME_PROVES = Object.freeze([
  'The packaged main process can save and persistently verify a credential-free OpenAI-compatible provider against a token-bound literal-loopback endpoint.',
  'The packaged production adapter registry and RunManager can stream a first task turn and persist its successful assistant output, provider attribution, continuation state, and idle status.'
])

export const PROVIDER_RUNTIME_DOES_NOT_PROVE = Object.freeze([
  'Live hosted-provider credentials, internet reachability, or behavior of an external vendor service.',
  'CLI-agent execution, tool execution, or provider protocols other than OpenAI-compatible.'
])

function sameStringList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

export function hasCompleteProviderRuntimeEvidence(evidence) {
  return (
    evidence?.version === 1 &&
    evidence.fixture?.protocol === 'openai-compatible' &&
    evidence.fixture?.binding === 'token-bound-literal-loopback' &&
    evidence.fixture?.externalCredentialsUsed === false &&
    evidence.fixture?.modelDiscoveryRequests === 1 &&
    evidence.fixture?.streamingCompletionRequests === 1 &&
    evidence.fixture?.streamedContentChunks === 2 &&
    evidence.readiness?.passed === true &&
    evidence.readiness?.persisted === true &&
    evidence.readiness?.scope === 'connection' &&
    evidence.firstTurn?.runCompletedEventObserved === true &&
    evidence.firstTurn?.taskIdleAfterStateReload === true &&
    evidence.firstTurn?.assistantMarkerPersisted === true &&
    evidence.firstTurn?.providerAttributionPersisted === true &&
    evidence.firstTurn?.modelSessionPersisted === true &&
    evidence.firstTurn?.noFailurePersisted === true &&
    sameStringList(evidence.claims?.proves, PROVIDER_RUNTIME_PROVES) &&
    sameStringList(
      evidence.claims?.doesNotProve,
      PROVIDER_RUNTIME_DOES_NOT_PROVE
    )
  )
}
