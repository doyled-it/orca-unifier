## Report format (every message to the Orchestrator)

Subject: `[<WORKER>] <KIND>: <headline under 10 words>` where WORKER is your short name and
KIND is STATE, ASK, BLOCKER or PITCH. Body, under 120 words, these lines only (omit empty
ones):

```
Node: <worktree or task>   State: <from> -> <to>
Result: <one sentence; the claim, with numbers>
Evidence: <paths, SHAs, merge request links>
Review: <review file or note naming the reviewed SHA>
Ask: <the exact decision or action you need, or none>
Next: <one line>
```

A pitch for new work carries five fields in a file (question, approach, expected evidence,
cost, kill criteria); the message gives the path and a one-line summary.
