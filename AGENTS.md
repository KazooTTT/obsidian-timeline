# Agent notes

Obsidian plugin: **KazooTTT Vault Timeline** (`kazoottt-obsidian-timeline`). Repo: https://github.com/KazooTTT/obsidian-timeline

## BRAT / GitHub Release

BRAT and the official Obsidian plugin market do **not** install from the repo root. They look at GitHub **Release assets**.

When adding `KazooTTT/obsidian-timeline` (or the full GitHub URL), BRAT:

1. Fetches the latest GitHub Release
2. Downloads assets named exactly `manifest.json`, `main.js`, and `styles.css`
3. Does **not** unzip a `.zip` asset, even if that zip contains those files

If `manifest.json` is missing as a **standalone release asset**, BRAT reports:

> This does not seem to be an obsidian plugin, as there is no manifest.json file.

A `manifest.json` in the repo root is not enough.

### Every release must include these assets

Upload all of these (zip is optional, for manual install only):

- `manifest.json`
- `main.js`
- `styles.css`
- `obsidian-timeline-<version>.zip` (optional)

Example:

```bash
gh release upload v0.2.0 --repo KazooTTT/obsidian-timeline manifest.json main.js styles.css
```

### Version / tag

Keep these the same:

- `manifest.json` → `version`
- GitHub release tag (e.g. `0.2.0` or `v0.2.0`)
- Release name

BRAT can coerce a `v` prefix via semver, but matching versions is required for official Obsidian releases.

### BRAT install path

Users should add:

```text
KazooTTT/obsidian-timeline
```

The full URL also works; BRAT strips `https://github.com/`.
