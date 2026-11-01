// One agent session in its own process: `node append-many.mjs <agent> <count>`
// makes <count> governor decisions against GOVERNOR_HOME, each one a receipt on
// the machine's one chain. chain-parallel-sessions.test.mjs starts several at
// once, as parallel Claude Code / Codex / Grok sessions do.
const [agent, count] = process.argv.slice(2);
const { createGovernor } = await import('../../core/index.mjs');
const gov = createGovernor({ harness: 'test-harness' });
for (let i = 0; i < Number(count); i++) {
  await gov.before({ agent, tool: 'Read', name: 'Read', action: `Read:/w/${agent}-${i}.ts`, input: {}, cwd: '/w/acme' });
}
