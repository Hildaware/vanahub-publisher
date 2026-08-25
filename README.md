# VanaHub Publisher

A repository-first release workbench for Ashita v4 addons, deployed at [hildaware.github.io/vanahub-publisher](https://hildaware.github.io/vanahub-publisher/).

VanaHub Publisher reads an immutable snapshot of a public GitHub repository, finds an addon directory, normalizes it, and runs structural and Lua checks in a Web Worker. Source bytes stay in volatile browser memory. A local folder or ZIP remains available for uncommitted and non-GitHub source.

## GitHub publishing flow

The normal setup has no local CLI requirement:

1. Paste a public GitHub repository URL and select the addon directory.
2. Complete metadata and pass local validation.
3. Copy the generated `.github/workflows/vanahub-setup.yml` into the repository and run it once.
4. Review and merge the setup PR that installs `.vanahub/package.json`, `.vanahub.json`, and the permanent release workflow.
5. Publish a stable GitHub Release. Its SemVer tag supplies the package version and its body supplies the changelog.

The release workflow attaches a normalized addon ZIP, `vanahub-manifest.json`, `validation-report.json`, and `SHA256SUMS.txt`. The first catalog release is requested through the linked catalog issue form; later releases are discovered automatically by the catalog.

## Publishing modes

- **Built-in:** GitHub-only. Structural, prohibited-Lua, module, capability, metadata, and current catalog-schema checks must pass. The result is described as “eligible for the screened catalog,” never “safe.”
- **Custom repository:** Structural archive checks still block. Elevated Lua findings are warnings and are included prominently in `validation-report.json` and `custom-package.json`.

Local-source mode can still export a normalized ZIP or a manual publishing kit, but it does not install repository automation.

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
