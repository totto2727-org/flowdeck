# Skill evaluation

Use these cases only when reviewing or revising `develop-flowdeck-workflows`. Run each case in a clean Flowdeck worktree without provider credentials unless the case explicitly needs them.

## Triggering cases

| Prompt | Expected activation |
| --- | --- |
| `Use the Flowdeck workflow skill to add a code-defined approval workflow.` | Trigger: the request explicitly creates a workflow contract. |
| `Add a conditional node and another input field to demo-workflow.` | Trigger: the request changes workflow input, topology, and execution. |
| `Restyle the Flowdeck run-history table without changing a workflow.` | Do not trigger: this is generic UI work outside a workflow contract. |

Record whether the client loaded this skill for each prompt. A single observation is execution evidence for that run, not a stable activation rate.

## Functional cases

### Linear workflow

Prompt: `Add a code-defined approval workflow with subject and reviewer inputs, four linear nodes, and no schedule.`

Expected result:

- The workflow owns a validated form, defaults, parser, topology, and graph definition.
- Every registry boundary is exhaustive, including explicit unknown-schedule handling.
- Automated tests cover valid input, invalid input, graph completion, topology, and trace history.
- Browser QA observes the submitted run reach `Completed` with the declared route.

### Filesystem boundary

Prompt: `Add a workflow that reads a workspace-relative source file before executing a jcode node.`

Expected result:

- Lexical validation rejects absolute paths and parent traversal.
- Canonical containment rejects symlink escapes from the workspace.
- File access uses Tokio or `spawn_blocking` instead of blocking the async executor.
- Unit tests stay runtime-free; focused integration or manual QA owns the real jcode dependency.

## Performance

Performance comparison is not applicable by default because this skill does not claim lower latency, fewer tool calls, or bulk file processing. Add a same-prompt baseline only when a revision claims an efficiency improvement.
