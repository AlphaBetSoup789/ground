import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import packageMetadata from '../package.json' with { type: 'json' }
import { classifyUnsignedMacSignature } from './lib/mac-signature.mjs'
import {
  CLI_RUNTIME_DOES_NOT_PROVE,
  CLI_RUNTIME_PROVES,
  PROVIDER_FAILURE_RUNTIME_DOES_NOT_PROVE,
  PROVIDER_FAILURE_RUNTIME_PROVES,
  PROVIDER_RUNTIME_DOES_NOT_PROVE,
  PROVIDER_RUNTIME_PROVES,
  REQUIRED_NATIVE_RUNTIME_CHECKS
} from './lib/package-runtime-evidence-contract.mjs'
import {
  PACKAGED_CLI_SMOKE_DOES_NOT_PROVE,
  PACKAGED_CLI_SMOKE_PROVES
} from '../src/main/packaged-cli-smoke.ts'
import {
  PACKAGED_PROVIDER_FAILURE_SMOKE_DOES_NOT_PROVE,
  PACKAGED_PROVIDER_FAILURE_SMOKE_PROVES
} from '../src/main/packaged-provider-failure-smoke.ts'
import {
  PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE,
  PACKAGED_PROVIDER_SMOKE_PROVES
} from '../src/main/packaged-provider-smoke.ts'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')
const temporaryDirectories = []
const targets = [
  ['darwin', 'arm64', 'mac-zip-extracted', 'mac-arm64.zip'],
  ['darwin', 'x64', 'mac-zip-extracted', 'mac-x64.zip'],
  ['win32', 'x64', 'windows-nsis-installed', 'windows-x64.exe'],
  ['linux', 'x64', 'linux-appimage-extracted', 'linux-x64.AppImage']
]
const allArtifacts = [
  'mac-arm64.zip',
  'mac-arm64.dmg',
  'mac-x64.zip',
  'mac-x64.dmg',
  'windows-x64.exe',
  'linux-x64.AppImage',
  'linux-x64.deb'
].map((suffix) => `Ground-${packageMetadata.version}-${suffix}`)
const releaseCommit = 'a'.repeat(40)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fixtureDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ground-package-release-test-')
  )
  temporaryDirectories.push(directory)
  for (const name of allArtifacts) {
    await writeFile(path.join(directory, name), `artifact:${name}\n`)
  }
  return directory
}

async function runScript(script, args, environment = {}) {
  return execFileAsync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    env: {
      ...process.env,
      ...environment
    }
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('release artifact and runtime-evidence verification', () => {
  it('keeps packaged-runtime proof claims synchronized with the release contract', () => {
    expect([...PACKAGED_PROVIDER_SMOKE_PROVES]).toEqual([
      ...PROVIDER_RUNTIME_PROVES
    ])
    expect([...PACKAGED_PROVIDER_SMOKE_DOES_NOT_PROVE]).toEqual([
      ...PROVIDER_RUNTIME_DOES_NOT_PROVE
    ])
    expect([...PACKAGED_PROVIDER_FAILURE_SMOKE_PROVES]).toEqual([
      ...PROVIDER_FAILURE_RUNTIME_PROVES
    ])
    expect([
      ...PACKAGED_PROVIDER_FAILURE_SMOKE_DOES_NOT_PROVE
    ]).toEqual([...PROVIDER_FAILURE_RUNTIME_DOES_NOT_PROVE])
    expect([...PACKAGED_CLI_SMOKE_PROVES]).toEqual([
      ...CLI_RUNTIME_PROVES
    ])
    expect([...PACKAGED_CLI_SMOKE_DOES_NOT_PROVE]).toEqual([
      ...CLI_RUNTIME_DOES_NOT_PROVE
    ])
  })

  it('uses canonical Linux x64 names and accepts only unsigned macOS identities', () => {
    expect(packageMetadata.build.linux.artifactName).toBe(
      'Ground-${version}-linux-x64.${ext}'
    )
    expect(
      classifyUnsignedMacSignature(
        1,
        '/tmp/Ground.app: code object is not signed at all'
      )
    ).toBe('completely-unsigned')
    expect(
      classifyUnsignedMacSignature(
        0,
        'Signature=adhoc\nTeamIdentifier=not set'
      )
    ).toBe('adhoc-teamless')
    expect(
      classifyUnsignedMacSignature(
        0,
        'Signature=adhoc\nTeamIdentifier=not set\nAuthority=Developer ID Application: Example'
      )
    ).toBeUndefined()
    expect(
      classifyUnsignedMacSignature(1, 'codesign failed unexpectedly')
    ).toBeUndefined()
  })

  it('requires the exact complete cross-platform artifact inventory', async () => {
    const directory = await fixtureDirectory()
    await expect(
      runScript('scripts/verify-package-artifacts.mjs', ['--all', directory])
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Verified exact package artifact inventory')
    })

    await writeFile(path.join(directory, 'Ground-surprise.exe'), 'unexpected\n')
    await expect(
      runScript('scripts/verify-package-artifacts.mjs', ['--all', directory])
    ).rejects.toThrow(/exact package artifacts/iu)
  })

  it('binds every runtime-evidence record to its exact distributable bytes', async () => {
    const directory = await fixtureDirectory()
    for (const [platform, architecture, source, suffix] of targets) {
      const artifact = `Ground-${packageMetadata.version}-${suffix}`
      const contents = `artifact:${artifact}\n`
      const checks = Object.fromEntries(
        REQUIRED_NATIVE_RUNTIME_CHECKS.map((name) => [name, true])
      )
      const document = {
        version: 1,
        status: 'passed',
        commit: releaseCommit,
        packageVersion: packageMetadata.version,
        platform,
        architecture,
        installationSource: source,
        runtimeHarness: {
          nodeSha256: 'b'.repeat(64),
          cliRunnerMatched: true
        },
        distributable: {
          name: artifact,
          sha256: sha256(contents)
        },
        checks,
        evidence: {
          version: 1,
          app: {
            packaged: true,
            name: packageMetadata.build.productName,
            version: packageMetadata.version,
            configuredAppId: packageMetadata.build.appId,
            platform,
            architecture
          },
          credentialStorage: {
            encryptionAvailable: true,
            roundTrip: true,
            ...(platform === 'linux'
              ? { backend: 'gnome_libsecret' }
              : {})
          },
          nativeApproval: { cancelled: true },
          mcpLaunchApproval: { exactEnvelopeValidated: true },
          cliRuntime: {
            version: 1,
            fixture: {
              dialect: 'codex',
              adapterId: 'openai.codex-cli',
              binding: 'token-bound-runner-node-child',
              selection: 'source-registered-recognized-adapter',
              passiveDetectionExercised: false,
              externalCredentialsUsed: false,
              externalVendorCliUsed: false,
              runnerNodeSha256: 'b'.repeat(64),
              scriptSha256: 'c'.repeat(64),
              structuredRecordsEmitted: 7,
              stdinPromptTokenObserved: true
            },
            readiness: {
              passed: true,
              persisted: true,
              scope: 'configuration'
            },
            trust: {
              configurationAuthorizations: 1,
              invocationAuthorizations: 1,
              exactLaunchEnvelopeValidated: true,
              exactConfigurationValidated: true,
              exactInvocationValidated: true,
              fixtureRevalidatedBeforeEachAuthorization: true,
              humanApprovalExercised: false
            },
            firstTurn: {
              runCompletedEventObserved: true,
              taskIdleAfterStateReload: true,
              assistantMarkerPersisted: true,
              providerAttributionPersisted: true,
              runtimeSessionPersisted: true,
              successfulCommandLifecyclePersisted: true,
              usagePersisted: true,
              warningNoticeCount: 1,
              noFailurePersisted: true
            },
            claims: {
              proves: [...CLI_RUNTIME_PROVES],
              doesNotProve: [...CLI_RUNTIME_DOES_NOT_PROVE]
            }
          },
          providerRuntime: {
            version: 2,
            fixture: {
              protocol: 'openai-compatible',
              binding: 'token-bound-literal-loopback',
              externalCredentialsUsed: false,
              modelDiscoveryRequests: 1,
              streamingCompletionRequests: 1,
              streamedContentChunks: 2
            },
            readiness: {
              passed: true,
              persisted: true,
              scope: 'connection'
            },
            firstTurn: {
              runCompletedEventObserved: true,
              taskIdleAfterStateReload: true,
              assistantMarkerPersisted: true,
              providerAttributionPersisted: true,
              modelSessionPersisted: true,
              noFailurePersisted: true
            },
            openAiResponses: {
              fixture: {
                providerKind: 'openai',
                protocol: 'openai-responses',
                adapterId: 'openai.responses',
                binding: 'token-bound-literal-loopback',
                externalCredentialsUsed: false,
                syntheticCredentialAuthorizationValidated: true,
                modelDiscoveryRequests: 1,
                streamingResponseRequests: 1,
                streamedContentChunks: 2,
                responsesRequestValidated: true,
                storeDisabled: true
              },
              credentials: {
                required: true,
                versionedReferencePersisted: true,
                reusedForReadiness: true,
                reusedForFirstTurn: true,
                absentFromPersistedState: true
              },
              readiness: {
                passed: true,
                persisted: true,
                scope: 'connection'
              },
              firstTurn: {
                runCompletedEventObserved: true,
                taskIdleAfterStateReload: true,
                assistantMarkerPersisted: true,
                providerAttributionPersisted: true,
                modelSessionPersisted: true,
                noFailurePersisted: true
              }
            },
            claims: {
              proves: [...PROVIDER_RUNTIME_PROVES],
              doesNotProve: [...PROVIDER_RUNTIME_DOES_NOT_PROVE]
            }
          },
          providerFailureRuntime: {
            version: 2,
            fixture: {
              protocol: 'openai-compatible',
              binding: 'token-bound-literal-loopback',
              externalCredentialsUsed: false,
              malformedModelDiscoveryRequests: 1,
              malformedGenerationRequests: 1
            },
            unavailableLoopback: {
              expectedFailureObserved: true,
              failureKind: 'connection-refused',
              failedConnectionReadinessPersisted: true,
              correctiveGuidanceObserved: true,
              genericFetchFailureHidden: true,
              runBlockedBeforeDispatch: true
            },
            malformedResponse: {
              expectedFailureObserved: true,
              phase: 'readiness',
              failureKind: 'protocol-shape',
              failureKindPersisted: true,
              failedConnectionReadinessPersisted: true,
              invalidAssistantShapeObserved: true,
              notMisclassifiedAsConnectionRefused: true,
              runBlockedBeforeDispatch: true
            },
            claims: {
              proves: [...PROVIDER_FAILURE_RUNTIME_PROVES],
              doesNotProve: [
                ...PROVIDER_FAILURE_RUNTIME_DOES_NOT_PROVE
              ]
            }
          }
        }
      }
      await writeFile(
        path.join(
          directory,
          `ground-package-runtime-evidence-${platform}-${architecture}.json`
        ),
        `${JSON.stringify(document)}\n`
      )
    }

    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(
        'Verified 4 distributable package runtime-evidence records'
      )
    })

    const linuxEvidencePath = path.join(
      directory,
      'ground-package-runtime-evidence-linux-x64.json'
    )
    const linuxEvidence = JSON.parse(
      await readFile(linuxEvidencePath, 'utf8')
    )
    delete linuxEvidence.evidence.credentialStorage.backend
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/security evidence is incomplete/iu)
    linuxEvidence.evidence.credentialStorage.backend = 'gnome_libsecret'
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )

    linuxEvidence.evidence.providerRuntime.claims.doesNotProve = []
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/provider runtime evidence is incomplete/iu)
    linuxEvidence.evidence.providerRuntime.claims.doesNotProve = [
      ...PROVIDER_RUNTIME_DOES_NOT_PROVE
    ]
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )

    linuxEvidence.evidence.providerRuntime.openAiResponses.fixture.storeDisabled =
      false
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/provider runtime evidence is incomplete/iu)
    linuxEvidence.evidence.providerRuntime.openAiResponses.fixture.storeDisabled =
      true

    linuxEvidence.evidence.providerFailureRuntime.unavailableLoopback.runBlockedBeforeDispatch =
      false
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/expected-failure runtime evidence is incomplete/iu)
    linuxEvidence.evidence.providerFailureRuntime.unavailableLoopback.runBlockedBeforeDispatch =
      true

    linuxEvidence.evidence.providerFailureRuntime.malformedResponse.failureKind =
      'connection-refused'
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/expected-failure runtime evidence is incomplete/iu)
    linuxEvidence.evidence.providerFailureRuntime.malformedResponse.failureKind =
      'protocol-shape'

    linuxEvidence.evidence.cliRuntime.firstTurn.warningNoticeCount = 0
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/recognized CLI runtime evidence is incomplete/iu)
    linuxEvidence.evidence.cliRuntime.firstTurn.warningNoticeCount = 1

    linuxEvidence.runtimeHarness.nodeSha256 = 'd'.repeat(64)
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/recognized CLI runtime evidence is incomplete/iu)
    linuxEvidence.runtimeHarness.nodeSha256 = 'b'.repeat(64)
    await writeFile(
      linuxEvidencePath,
      `${JSON.stringify(linuxEvidence)}\n`
    )

    await writeFile(
      path.join(
        directory,
        `Ground-${packageMetadata.version}-windows-x64.exe`
      ),
      'changed bytes\n'
    )
    await expect(
      runScript('scripts/verify-package-runtime-evidence.mjs', [directory], {
        GITHUB_SHA: releaseCommit
      })
    ).rejects.toThrow(/distributable hash does not match/iu)
  })
})
