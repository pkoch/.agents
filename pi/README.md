# pi

[pi](https://pi.dev)-specific configuration: extensions and repo-managed agent defaults.

## Layout

```text
agent/sandbox.json   Repo-managed Pi sandbox defaults
extensions/          Pi extensions and extension packages
```

Most extensions are stand-alone modules. Some enrich each other through events, but that does not affect their core functionality.

`extensions/telegram/` and `extensions/sandbox/` are package-backed extensions because they ship extra runtime code or dependencies.
