import { describe, expect, it } from 'vitest'

import {
  loadBenchmarkDefinition,
  mergeAgentEvidenceFragments,
  validateAgentEvidence
} from './model.mjs'
import { validAgentEvidence } from '../../tests/release/fixtures/evidence.mjs'

describe('frozen reference-agent benchmark', () => {
  it('pins exact clients, models, configs, runners, network, prompt, task, and integration files', async () => {
    const definition = await loadBenchmarkDefinition()
    expect(definition.catalog.agents.map((agent) => agent.id)).toEqual(['codex', 'opencode', 'omp'])
    expect(definition.catalog.adapters).toEqual(['cli-skill', 'mcp'])
    expect(definition.catalog.requiredRunsPerAdapter).toBe(5)
    expect(definition.catalog.minimumPassesPerAdapter).toBe(4)
    expect(definition.policy.mandatoryTasks).toHaveLength(28)
    expect(new Set(definition.policy.mandatoryTasks)).toEqual(
      new Set(definition.conformanceCatalog.tasks.map((task) => task.id))
    )
  })

  it('accepts exactly five scored runs and at least four oracle matches per adapter', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validAgentEvidence(definition, 'a'.repeat(64))
    expect(() => validateAgentEvidence(evidence, definition)).not.toThrow()
  })

  it('rejects a scored run produced against another candidate package set', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validAgentEvidence(definition, 'a'.repeat(64))
    evidence.runs[0]!.candidateDigest = 'b'.repeat(64)
    expect(() => validateAgentEvidence(evidence, definition)).toThrow(/frozen value/)
  })

  it('assembles one privacy-safe fragment from each interactive agent runner', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validAgentEvidence(definition, 'a'.repeat(64))
    const fragments = definition.catalog.agents.map(({ id: agentId }) => ({
      agentId,
      schemaVersion: evidence.schemaVersion,
      freezeId: evidence.freezeId,
      fixtureVersion: evidence.fixtureVersion,
      catalogSha256: evidence.catalogSha256,
      candidatePackageSetSha256: evidence.candidatePackageSetSha256,
      config: evidence.configs.find((config) => config.agentId === agentId),
      runs: evidence.runs.filter((run) => run.agentId === agentId),
      invalidatedRuns: [],
      promptInjectionCharacterization: evidence.promptInjectionCharacterization.filter(
        (record) => record.agentId === agentId
      )
    }))
    expect(mergeAgentEvidenceFragments(fragments, definition).runs).toHaveLength(30)
  })

  it('rejects a 3/5 adapter result and retained raw application content', async () => {
    const definition = await loadBenchmarkDefinition()
    const evidence = validAgentEvidence(definition, 'a'.repeat(64))
    evidence.runs.find((run) => run.runId === 'codex-mcp-4')!.status = 'failed'
    evidence.runs.find((run) => run.runId === 'codex-mcp-4')!.oracleMatched = false
    evidence.runs.find((run) => run.runId === 'codex-mcp-4')!.failureClass = 'agent-task-failure'
    expect(() => validateAgentEvidence(evidence, definition)).toThrow(/passed 3\/5/)

    const withRawContent = validAgentEvidence(definition, 'a'.repeat(64)) as Record<string, unknown>
    withRawContent.screenshot = 'forbidden'
    expect(() => validateAgentEvidence(withRawContent, definition)).toThrow(/must not be retained/)
  })
})
