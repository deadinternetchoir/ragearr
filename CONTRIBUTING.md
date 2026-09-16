# Contributing to Ragearr

Ragearr is early-alpha software. Small, focused PRs are much more useful than large rewrites while the app shape is still settling.

## Useful Areas

- **Download clients** (`src/services/downloadClients/`) — rTorrent over SSH/SCGI is implemented. qBittorrent, Transmission, Deluge, SABnzbd, and NZBGet are open.
- **Candidate scoring** (`src/services/youtube.js`, `src/services/candidateRules.js`) — improve false-positive handling for music-video search while keeping the review-first workflow.
- **Import sources** (`src/services/importLists.js`, `src/services/spotify.js`) — more playlist/export formats and better edge-case parsing.
- **Installer/docs polish** — clearer examples for Docker, reverse proxies, first-run auth, and real-world library layouts.
- **UI polish** (`src/public/`) — accessibility, keyboard flow, mobile layout, and clearer settings/error states.
- **Health checks** (`src/services/systemHealth.js`) — checks for additional tools/integrations as they are added.
- **Tests** (`scripts/test-*.js`) — the project currently uses small no-framework Node scripts. Keep tests cheap to run and easy to read.

## Development

Ragearr runs on Node.js and SQLite. There is no frontend build step.

```bash
npm install
npm run dev
```

The app stores data under `/config` in Docker, or `./data` when run directly unless `RAGEARR_DATA_DIR` is set.

Useful checks:

```bash
npm run test:import-lists
npm run test:candidate-rules
npm run test:spotify
npm run test:root-folders
npm run test:backups
npm run test:users
```

Smoke test against a running instance:

```bash
RAGEARR_BASE_URL=http://127.0.0.1:5299 RAGEARR_API_KEY=your-key npm run smoke
```

## Security

Do not commit real data, SQLite databases, playlist exports, API keys, webhook URLs, SSH keys, or generated config directories. The `.gitignore` is deliberately broad for local data, but review your diff before opening a PR.

If you find a security issue, please open a private disclosure channel or contact the maintainer before filing a public issue with exploit details.

## Code Style

- Prefer the existing Node/Express/SQLite/vanilla-JS style.
- Keep changes focused and easy to test.
- Avoid new dependencies unless they remove meaningful complexity.
- Add comments for non-obvious reasoning, not for line-by-line narration.
- Keep user-facing errors specific enough to act on without leaking secrets.

## License

By contributing, you agree your contribution is licensed under GPL-3.0, matching the project.
