# Generic CLI example

`echo-agent.mjs` is a dependency-free example of Ground's Generic CLI JSON Lines
contract. It reads one prompt from stdin, emits two assistant text deltas, and
exits.

Run it directly:

```bash
printf 'hello Ground' | node examples/generic-cli/echo-agent.mjs
```

Then follow [the Generic CLI bridge guide](../../docs/GENERIC-CLI.md) to connect it
to the desktop. Replace the deterministic response with your model or agent call;
keep the stdin, JSON-line, exit-status, cancellation, and output-bound behavior.
