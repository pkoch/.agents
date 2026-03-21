# pi

[pi](https://pi.dev)-specific configuration: extensions and repo-managed agent defaults.

## Layout

```text
agent/sandbox.json   Repo-managed Pi sandbox defaults
extensions/          Pi extensions and extension packages
```

Most extensions are stand-alone modules. Some enrich each other through events, but that does not affect their core functionality.

`extensions/sandbox/` is package-backed because it ships extra runtime code and dependencies.
