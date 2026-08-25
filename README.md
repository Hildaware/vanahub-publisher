# VanaHub Publisher

A browser-only release workbench for Ashita v4 addons, deployed at [hildaware.github.io/vanahub-publisher](https://hildaware.github.io/vanahub-publisher/).

VanaHub Publisher reads a local addon folder or ZIP, normalizes it, runs structural and advisory Lua checks in a Web Worker, creates deterministic ZIPs, calculates SHA-256 with Web Crypto, and emits the files needed for publishing. Source bytes stay in volatile browser memory. There are no accounts, analytics, uploads, remote artifact requests, or automatic catalog pull requests.

## Publishing modes

- **Built-in:** GitHub-only. Structural, prohibited-Lua, module, capability, metadata, and current catalog-schema checks must pass. The result is described as “eligible for the screened catalog,” never “safe.”
- **Custom repository:** Structural archive checks still block. Elevated Lua findings are warnings and are included prominently in `validation-report.json` and `custom-package.json`.

The app can export without a final artifact URL. In that case it emits `catalog-manifest.draft.json`, which is intentionally non-submittable.

## Local development

```sh
npm ci
npm run dev
```

Quality checks:

```sh
npm run format:check
npm run lint
npm run check
npm test
npm run build
npm run test:browser
```

The Vite base is `/vanahub-publisher/`; production output is entirely static.

## Contract synchronization

Production builds use only the vendored VanaHub package schema and scanner policy. Their upstream repository, full commit SHA, versions, and hashes are recorded in `vendor/vanahub/contracts.lock.json`.

Verify the vendored bytes without network access:

```sh
npm run contracts:check
```

Refresh from the already-pinned commit (this command is the only contract-fetching path):

```sh
npm run contracts:sync
```

To use a local checkout, run `npm run contracts:sync -- --source /path/to/vanahub`. Update the lock commit intentionally before synchronizing to a reviewed newer contract. Differential CI checks shared hostile cases against the authoritative Python scanner at the pinned commit.

## Privacy and security boundary

Browser storage contains metadata and source fingerprints only—not addon content or local filesystem paths. **Forget everything** removes the persisted draft and in-memory source. Project JSON exports follow the same metadata-only rule. Icon and screenshot URLs are stored as text and never loaded by the app.

Static analysis cannot prove Lua is harmless. A passing report only says that the package complied with the pinned automated policy at the time it was generated.

## License

MIT
