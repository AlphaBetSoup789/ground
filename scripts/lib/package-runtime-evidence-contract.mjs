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
  'providerOpenAiResponsesFirstTurn',
  'providerUnavailableLoopbackHandled',
  'providerMalformedResponseHandled',
  'recognizedCliFirstTurn',
  'cliNonFatalWarningSuccessful',
  'mcp',
  'mcpLaunchApproval',
  'processTreeCancellation'
])

export const PROVIDER_RUNTIME_PROVES = Object.freeze([
  'The packaged main process can save and persistently verify a credential-free OpenAI-compatible provider against a token-bound literal-loopback endpoint.',
  'The packaged production adapter registry and RunManager can stream a first task turn and persist its successful assistant output, provider attribution, continuation state, and idle status.',
  'The packaged main process can save and persistently verify a first-class OpenAI provider with a synthetic versioned credential, then reuse that saved credential as exact Bearer authorization for readiness and runtime without exposing it in persisted state or evidence.',
  'The packaged production registry routes the first-class provider through openai.responses, sends a store-disabled Responses API request, parses its streamed Responses events, and durably persists the successful OpenAI-attributed first turn.'
])

export const PROVIDER_RUNTIME_DOES_NOT_PROVE = Object.freeze([
  'Live hosted-provider credentials, internet, DNS, or TLS reachability, authentication against OpenAI, rate-limit behavior, or any external vendor service.',
  'CLI-agent execution, tool execution, reasoning, multi-turn continuation, malformed or unavailable-provider handling, or first-class API protocols other than OpenAI Responses.'
])

export const PROVIDER_FAILURE_RUNTIME_PROVES = Object.freeze([
  'The packaged main process classifies a closed literal-loopback compatible endpoint as connection-refused, persists failed connection readiness, and blocks task dispatch through that provider.',
  'The packaged main process classifies deterministic malformed OpenAI-compatible readiness responses as protocol-shape, persists that bounded failure kind with failed connection readiness, and blocks task dispatch through that provider.'
])

export const PROVIDER_FAILURE_RUNTIME_DOES_NOT_PROVE = Object.freeze([
  'DNS, TLS, authentication, rate-limit, timeout, renderer presentation of corrective guidance, or exclusive ownership of the released closed-port number between allocation and probe.',
  'Every malformed response shape, hostile arbitrary servers, external vendor behavior, credential handling, CLI execution, tool execution, or protocols other than OpenAI-compatible.'
])

export const CLI_RUNTIME_PROVES = Object.freeze([
  'The packaged production registry and RunManager can invoke a source-registered Codex-dialect CLI adapter through Ground’s exact executable, configuration, invocation, workspace, argument, and prompt trust boundaries.',
  'A token-bound deterministic CLI child can stream a Codex session, successful command lifecycle, non-fatal warning, assistant response, completion, and usage through the packaged app and durable task state without inheriting external credentials.',
  'A completed Codex error item remains a persisted non-fatal runtime notice while the containing task turn completes successfully.'
])

export const CLI_RUNTIME_DOES_NOT_PROVE = Object.freeze([
  'An installed or authenticated Codex CLI, Codex service or network compatibility, vendor tool execution, vendor sandbox behavior, or vendor permission behavior.',
  'Human acceptance of the native CLI configuration or invocation dialogs, passive CLI detection, CLI adapters other than Codex, or race-free binding of interpreter script arguments against concurrent same-user replacement, including for this smoke-owned fixture.',
  'Cleanup of a hung or hostile external CLI after abnormal application exit.'
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
    evidence?.version === 2 &&
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
    evidence.openAiResponses?.fixture?.providerKind === 'openai' &&
    evidence.openAiResponses?.fixture?.protocol === 'openai-responses' &&
    evidence.openAiResponses?.fixture?.adapterId === 'openai.responses' &&
    evidence.openAiResponses?.fixture?.binding ===
      'token-bound-literal-loopback' &&
    evidence.openAiResponses?.fixture?.externalCredentialsUsed === false &&
    evidence.openAiResponses?.fixture
      ?.syntheticCredentialAuthorizationValidated === true &&
    evidence.openAiResponses?.fixture?.modelDiscoveryRequests === 1 &&
    evidence.openAiResponses?.fixture?.streamingResponseRequests === 1 &&
    evidence.openAiResponses?.fixture?.streamedContentChunks === 2 &&
    evidence.openAiResponses?.fixture?.responsesRequestValidated === true &&
    evidence.openAiResponses?.fixture?.storeDisabled === true &&
    evidence.openAiResponses?.credentials?.required === true &&
    evidence.openAiResponses?.credentials?.versionedReferencePersisted ===
      true &&
    evidence.openAiResponses?.credentials?.reusedForReadiness === true &&
    evidence.openAiResponses?.credentials?.reusedForFirstTurn === true &&
    evidence.openAiResponses?.credentials?.absentFromPersistedState === true &&
    evidence.openAiResponses?.readiness?.passed === true &&
    evidence.openAiResponses?.readiness?.persisted === true &&
    evidence.openAiResponses?.readiness?.scope === 'connection' &&
    evidence.openAiResponses?.firstTurn?.runCompletedEventObserved === true &&
    evidence.openAiResponses?.firstTurn?.taskIdleAfterStateReload === true &&
    evidence.openAiResponses?.firstTurn?.assistantMarkerPersisted === true &&
    evidence.openAiResponses?.firstTurn?.providerAttributionPersisted ===
      true &&
    evidence.openAiResponses?.firstTurn?.modelSessionPersisted === true &&
    evidence.openAiResponses?.firstTurn?.noFailurePersisted === true &&
    sameStringList(evidence.claims?.proves, PROVIDER_RUNTIME_PROVES) &&
    sameStringList(
      evidence.claims?.doesNotProve,
      PROVIDER_RUNTIME_DOES_NOT_PROVE
    )
  )
}

export function hasCompleteProviderFailureRuntimeEvidence(evidence) {
  return (
    evidence?.version === 2 &&
    evidence.fixture?.protocol === 'openai-compatible' &&
    evidence.fixture?.binding === 'token-bound-literal-loopback' &&
    evidence.fixture?.externalCredentialsUsed === false &&
    evidence.fixture?.malformedModelDiscoveryRequests === 1 &&
    evidence.fixture?.malformedGenerationRequests === 1 &&
    evidence.unavailableLoopback?.expectedFailureObserved === true &&
    evidence.unavailableLoopback?.failureKind === 'connection-refused' &&
    evidence.unavailableLoopback?.failedConnectionReadinessPersisted ===
      true &&
    evidence.unavailableLoopback?.correctiveGuidanceObserved === true &&
    evidence.unavailableLoopback?.genericFetchFailureHidden === true &&
    evidence.unavailableLoopback?.runBlockedBeforeDispatch === true &&
    evidence.malformedResponse?.expectedFailureObserved === true &&
    evidence.malformedResponse?.phase === 'readiness' &&
    evidence.malformedResponse?.failureKind === 'protocol-shape' &&
    evidence.malformedResponse?.failureKindPersisted === true &&
    evidence.malformedResponse?.failedConnectionReadinessPersisted === true &&
    evidence.malformedResponse?.invalidAssistantShapeObserved === true &&
    evidence.malformedResponse?.notMisclassifiedAsConnectionRefused ===
      true &&
    evidence.malformedResponse?.runBlockedBeforeDispatch === true &&
    sameStringList(
      evidence.claims?.proves,
      PROVIDER_FAILURE_RUNTIME_PROVES
    ) &&
    sameStringList(
      evidence.claims?.doesNotProve,
      PROVIDER_FAILURE_RUNTIME_DOES_NOT_PROVE
    )
  )
}

export function hasCompleteCliRuntimeEvidence(evidence) {
  return (
    evidence?.version === 1 &&
    evidence.fixture?.dialect === 'codex' &&
    evidence.fixture?.adapterId === 'openai.codex-cli' &&
    evidence.fixture?.binding === 'token-bound-runner-node-child' &&
    evidence.fixture?.selection === 'source-registered-recognized-adapter' &&
    evidence.fixture?.passiveDetectionExercised === false &&
    evidence.fixture?.externalCredentialsUsed === false &&
    evidence.fixture?.externalVendorCliUsed === false &&
    /^[a-f0-9]{64}$/u.test(evidence.fixture?.runnerNodeSha256 ?? '') &&
    /^[a-f0-9]{64}$/u.test(evidence.fixture?.scriptSha256 ?? '') &&
    evidence.fixture?.structuredRecordsEmitted === 7 &&
    evidence.fixture?.stdinPromptTokenObserved === true &&
    evidence.readiness?.passed === true &&
    evidence.readiness?.persisted === true &&
    evidence.readiness?.scope === 'configuration' &&
    evidence.trust?.configurationAuthorizations === 1 &&
    evidence.trust?.invocationAuthorizations === 1 &&
    evidence.trust?.exactLaunchEnvelopeValidated === true &&
    evidence.trust?.exactConfigurationValidated === true &&
    evidence.trust?.exactInvocationValidated === true &&
    evidence.trust?.fixtureRevalidatedBeforeEachAuthorization === true &&
    evidence.trust?.humanApprovalExercised === false &&
    evidence.firstTurn?.runCompletedEventObserved === true &&
    evidence.firstTurn?.taskIdleAfterStateReload === true &&
    evidence.firstTurn?.assistantMarkerPersisted === true &&
    evidence.firstTurn?.providerAttributionPersisted === true &&
    evidence.firstTurn?.runtimeSessionPersisted === true &&
    evidence.firstTurn?.successfulCommandLifecyclePersisted === true &&
    evidence.firstTurn?.usagePersisted === true &&
    evidence.firstTurn?.warningNoticeCount === 1 &&
    evidence.firstTurn?.noFailurePersisted === true &&
    sameStringList(evidence.claims?.proves, CLI_RUNTIME_PROVES) &&
    sameStringList(
      evidence.claims?.doesNotProve,
      CLI_RUNTIME_DOES_NOT_PROVE
    )
  )
}
