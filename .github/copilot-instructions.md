# Copilot / AI instructions

See [`AGENTS.md`](../AGENTS.md) — main entry point for coding agents.

Quick rules:
- Node.js CommonJS, no frontend build step.
- Run `npm run check && npm test` before proposing changes.
- Never commit `.env`, `data/`, `backups/`, keys, certs, or debug keystores.
- Use `safeJoin` and `projectGuard` for all file/project access.
- Darcus ACTION types must be added consistently in `darcus.js`, `AI_ACTION_TYPES`,
  and `runAiAction` in `public/app.js`.
- Mobile UI must work at 320/360/390 px.
- Full docs: [`documenti/README.md`](../documenti/README.md).
