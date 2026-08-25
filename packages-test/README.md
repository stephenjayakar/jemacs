# packages-test/

Integration tests for plugins that live in Stephen's separate
`jemacs-packages` repository.

They use `~/.jemacs/packages` by default. Set `JEMACS_PACKAGES` to test any
checkout without requiring a particular repository layout. They are deliberately
outside `test/` so `bun test` does not pick them up by default.

Run explicitly:
```
JEMACS_PACKAGES=/path/to/jemacs-packages \
  bun test ./packages-test/projectile.ts ./packages-test/file-sidebar.ts
```
