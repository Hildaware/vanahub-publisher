<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import {
    capabilities,
    type Capability,
    type PublisherProject,
    type SourceEntry,
    type ValidationReport,
  } from './lib/types';
  import { draft, forgetDraft } from './lib/state';
  import { PublisherWorker, type WorkerTask } from './lib/worker-client';
  import {
    deterministicZip,
    downloadBlob,
    fingerprints,
    sha256,
  } from './lib/archive';
  import { topLevelRoots } from './lib/path';
  import {
    artifactFilename,
    authorizationTemplate,
    buildCatalogManifest,
    bundleFilename,
    customPackage,
    githubArtifactUrl,
    manifestErrors,
    projectDocument,
    stableJson,
    validateHosting,
    validateMetadata,
  } from './lib/project';

  const steps = ['Source', 'Metadata', 'Validation', 'Hosting', 'Export'];
  const worker = new PublisherWorker();
  let step = 0;
  let entries: SourceEntry[] = [];
  let roots: string[] = [];
  let selectedRoot = '';
  let sourceKind = '';
  let report: ValidationReport | null = null;
  let busy = false;
  let progress = 0;
  let status = 'Choose a local addon folder or ZIP to begin.';
  let errors: string[] = [];
  let activeTask: WorkerTask<any> | null = null;
  let heading: HTMLElement;
  let maintainersText = '';
  let screenshotsText = '';
  let importInput: HTMLInputElement;

  $: metadataErrors = validateMetadata($draft.metadata);
  $: hostingErrors = validateHosting($draft.metadata, $draft.hosting);
  $: expectedUrl = githubArtifactUrl($draft.metadata, $draft.hosting.tag);
  $: if (
    $draft.hosting.provider === 'github' &&
    expectedUrl !== $draft.hosting.artifactUrl
  ) {
    $draft.hosting.artifactUrl = expectedUrl;
  }

  onDestroy(() => worker.close());

  async function go(next: number) {
    step = Math.max(0, Math.min(steps.length - 1, next));
    errors = [];
    await tick();
    heading?.focus();
  }

  async function ingest(type: 'read-zip' | 'read-directory', files: File[]) {
    if (!files.length) return;
    activeTask?.cancel();
    busy = true;
    progress = 0;
    report = null;
    status = 'Reading source locally…';
    try {
      activeTask = worker.run<SourceEntry[]>(
        type === 'read-zip' ? { type, file: files[0] } : { type, files },
        (value) => (progress = value),
      );
      entries = await activeTask.promise;
      sourceKind = type === 'read-zip' ? 'ZIP archive' : 'folder';
      const paths = entries
        .filter((entry) => !entry.directory)
        .map((entry) => entry.path);
      roots =
        type === 'read-directory' && paths.some((path) => !path.includes('/'))
          ? []
          : topLevelRoots(paths);
      selectedRoot = roots.length === 1 ? roots[0] : '';
      status = `Loaded ${entries.filter((entry) => !entry.directory).length} files from the ${sourceKind}. No files left this browser.`;
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError')
        errors = [(error as Error).message];
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function selectedFiles(): SourceEntry[] {
    const prefix = selectedRoot ? `${selectedRoot.replace(/\/$/, '')}/` : '';
    return entries.filter(
      (entry) => !entry.directory && (!prefix || entry.path.startsWith(prefix)),
    );
  }

  async function runValidation() {
    errors = [...metadataErrors];
    if (!entries.length) errors.unshift('Choose source files first.');
    if (roots.length > 1 && !selectedRoot)
      errors.unshift('Select the ZIP payload root.');
    if (errors.length) return;
    busy = true;
    progress = 0;
    status = 'Analyzing archive structure and Lua in a worker…';
    try {
      activeTask = worker.run<ValidationReport>(
        {
          type: 'scan',
          entries,
          root: selectedRoot,
          metadata: $draft.metadata,
        },
        (value) => (progress = value),
      );
      const nextReport = await activeTask.promise;
      report = nextReport;
      const source = {
        files: await fingerprints(entries, selectedRoot),
        rootHint: selectedRoot,
        entrypoint: `${$draft.metadata.id}.lua`,
      };
      draft.update((value) => ({ ...value, source }));
      status = nextReport.structurallyValid
        ? nextReport.eligibleForScreenedCatalog
          ? 'All current checks pass. Eligible for the screened catalog.'
          : 'Structural checks pass. Review elevated custom-mode findings.'
        : 'Validation found structural blockers.';
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError')
        errors = [(error as Error).message];
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function cancel() {
    activeTask?.cancel();
    status = 'Operation cancelled.';
    busy = false;
  }

  function toggleCapability(capability: Capability) {
    const selected = $draft.metadata.declaredCapabilities;
    $draft.metadata.declaredCapabilities = selected.includes(capability)
      ? selected.filter((item) => item !== capability)
      : [...selected, capability];
    report = null;
  }

  function syncLists() {
    $draft.metadata.maintainers = maintainersText
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    $draft.metadata.screenshots = screenshotsText
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    report = null;
  }

  async function createArtifact(): Promise<{ blob: Blob; digest: string }> {
    const prefix = selectedRoot ? `${selectedRoot.replace(/\/$/, '')}/` : '';
    const files = selectedFiles().map((entry) => ({
      path: `${$draft.metadata.id}/${entry.path.slice(prefix.length)}`,
      bytes: entry.bytes,
    }));
    const blob = await deterministicZip(files);
    return { blob, digest: await sha256(blob) };
  }

  function canExport(): boolean {
    if (!report || metadataErrors.length || !report.structurallyValid)
      return false;
    return (
      $draft.metadata.mode === 'custom' || report.eligibleForScreenedCatalog
    );
  }

  async function exportArtifact() {
    if (!canExport()) return;
    busy = true;
    try {
      const artifact = await createArtifact();
      downloadBlob(artifact.blob, artifactFilename($draft.metadata));
      status = `Addon archive ready: ${artifact.digest}`;
    } finally {
      busy = false;
    }
  }

  async function exportBundle() {
    if (!canExport() || !report) return;
    busy = true;
    try {
      const artifact = await createArtifact();
      const filename = artifactFilename($draft.metadata);
      const project = projectDocument(
        $draft.metadata,
        $draft.hosting,
        get(draft).source,
      );
      const manifest = buildCatalogManifest(
        $draft.metadata,
        $draft.hosting.artifactUrl,
        artifact.digest,
        artifact.blob.size,
      );
      const finalManifest =
        $draft.metadata.mode === 'built-in' &&
        !!$draft.hosting.artifactUrl &&
        manifestErrors(manifest).length === 0 &&
        report.eligibleForScreenedCatalog;
      const publishing = `# Publishing ${$draft.metadata.name}\n\n1. Create tag \`${$draft.hosting.tag || `v${$draft.metadata.version}`}\`.\n2. Upload \`${filename}\` as a release asset.\n3. Commit \`metadata/.vanahub.json\` to the source repository root.\n${finalManifest ? '4. Submit `metadata/catalog-manifest.json` to the VanaHub catalog.\n' : '4. Complete hosting details before submitting the draft manifest.\n'}\nThe report means “eligible for the screened catalog,” never “safe.” Review all findings before publishing.\n`;
      const bundleEntries: { path: string; bytes: Uint8Array | string }[] = [
        {
          path: `artifact/${filename}`,
          bytes: new Uint8Array(await artifact.blob.arrayBuffer()),
        },
        { path: 'metadata/publisher-project.json', bytes: stableJson(project) },
        { path: 'metadata/validation-report.json', bytes: stableJson(report) },
        {
          path: 'metadata/SHA256SUMS.txt',
          bytes: `${artifact.digest}  ${filename}\n`,
        },
        {
          path: 'metadata/.vanahub.json',
          bytes: stableJson(authorizationTemplate($draft.metadata)),
        },
        {
          path: finalManifest
            ? 'metadata/catalog-manifest.json'
            : 'metadata/catalog-manifest.draft.json',
          bytes: stableJson(manifest),
        },
        { path: 'PUBLISHING.md', bytes: publishing },
      ];
      if ($draft.metadata.mode === 'custom')
        bundleEntries.push({
          path: 'metadata/custom-package.json',
          bytes: stableJson(
            customPackage(
              $draft.metadata,
              $draft.hosting,
              artifact.digest,
              artifact.blob.size,
              report,
            ),
          ),
        });
      const bundle = await deterministicZip(bundleEntries);
      downloadBlob(bundle, bundleFilename($draft.metadata));
      status = `Publishing bundle ready. Artifact SHA-256: ${artifact.digest}; ${artifact.blob.size} compressed bytes.`;
    } finally {
      busy = false;
    }
  }

  function exportProject() {
    const document = projectDocument(
      $draft.metadata,
      $draft.hosting,
      get(draft).source,
    );
    downloadBlob(
      new Blob([stableJson(document)], { type: 'application/json' }),
      `${$draft.metadata.id || 'vanahub'}-publisher-project.json`,
    );
  }

  async function importProject(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const project = JSON.parse(await file.text()) as PublisherProject;
      if (project.schemaVersion !== 1 || !project.metadata || !project.hosting)
        throw new Error('Unsupported publisher project.');
      draft.set({
        metadata: project.metadata,
        hosting: project.hosting,
        source: project.source,
      });
      maintainersText = project.metadata.maintainers.join(', ');
      screenshotsText = project.metadata.screenshots.join('\n');
      entries = [];
      report = null;
      status =
        'Draft metadata imported. Choose the source again; addon bytes were not stored.';
    } catch (error) {
      errors = [(error as Error).message];
    }
  }

  function forget() {
    forgetDraft();
    entries = [];
    report = null;
    roots = [];
    selectedRoot = '';
    maintainersText = '';
    screenshotsText = '';
    status = 'Draft and in-memory source forgotten.';
  }
</script>

<svelte:head
  ><meta
    name="description"
    content="Package and validate VanaHub addons entirely in your browser."
  /></svelte:head
>

<header class="topbar">
  <a
    class="brand"
    href="/vanahub-publisher/"
    aria-label="VanaHub Publisher home"
    ><span>V</span> VanaHub <b>Publisher</b></a
  >
  <div class="privacy"><i></i> Local processing only</div>
</header>

<main>
  <section class="hero">
    <p class="eyebrow">Release workbench</p>
    <h1>Package with confidence.<br /><em>Publish on your terms.</em></h1>
    <p>
      Inspect, screen, and prepare an Ashita addon without uploading its source.
    </p>
  </section>

  <nav class="steps" aria-label="Publishing steps">
    {#each steps as label, index (label)}
      <button
        class:active={step === index}
        class:complete={index < step}
        aria-current={step === index ? 'step' : undefined}
        onclick={() => go(index)}
      >
        <span>{index < step ? '✓' : index + 1}</span>{label}
      </button>
    {/each}
  </nav>

  <div class="workspace">
    <section class="panel" aria-labelledby="step-heading">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Step {step + 1} of 5</p>
          <h2 id="step-heading" tabindex="-1" bind:this={heading}>
            {steps[step]}
          </h2>
        </div>
        <span class="mode"
          >{$draft.metadata.mode === 'built-in'
            ? 'Screened catalog'
            : 'Custom repository'}</span
        >
      </div>

      {#if errors.length}
        <div class="error-summary" role="alert" tabindex="-1">
          <strong>Resolve these items</strong>
          <ul>
            {#each errors as error, index (`${index}-${error}`)}<li>
                {error}
              </li>{/each}
          </ul>
        </div>
      {/if}

      {#if step === 0}
        <p class="lede">
          Choose a folder or ZIP. Files are read into volatile browser memory
          and never sent anywhere.
        </p>
        <div class="source-grid">
          <label class="drop"
            ><input
              aria-label="Choose addon folder"
              type="file"
              multiple
              webkitdirectory
              onchange={(event) =>
                ingest('read-directory', [
                  ...((event.currentTarget as HTMLInputElement).files ?? []),
                ])}
            /><strong>Choose addon folder</strong><small
              >Best for a working copy</small
            ></label
          >
          <label class="drop"
            ><input
              aria-label="Choose existing ZIP"
              type="file"
              accept=".zip,application/zip"
              onchange={(event) =>
                ingest('read-zip', [
                  ...((event.currentTarget as HTMLInputElement).files ?? []),
                ])}
            /><strong>Choose existing ZIP</strong><small
              >Inspect before repackaging</small
            ></label
          >
        </div>
        {#if entries.length}
          {#if roots.length > 1}
            <label
              >Payload root<select bind:value={selectedRoot}
                ><option value="">Select the addon root…</option
                >{#each roots as root (root)}<option value={root}>{root}</option
                  >{/each}</select
              ><small
                >Entries outside the selected root are excluded, but still
                screened for unsafe paths.</small
              ></label
            >
          {/if}
          <div class="file-list">
            <div>
              <strong>{selectedFiles().length} included files</strong><span
                >Output root: {$draft.metadata.id || '<package-id>'}/</span
              >
            </div>
            <ul>
              {#each selectedFiles() as entry (entry.path)}<li>
                  <code>{entry.path}</code><span
                    >{entry.bytes.byteLength.toLocaleString()} B</span
                  >
                </li>{/each}
            </ul>
          </div>
        {/if}
      {:else if step === 1}
        <div class="form-grid">
          <label
            >Package ID<input
              bind:value={$draft.metadata.id}
              oninput={() => (report = null)}
              placeholder="my-addon"
            /><small
              >Also determines the required root entrypoint: {$draft.metadata
                .id || '<package-id>'}.lua</small
            ></label
          >
          <label
            >Name<input
              bind:value={$draft.metadata.name}
              placeholder="My Addon"
            /></label
          >
          <label class="wide"
            >Description<textarea
              bind:value={$draft.metadata.description}
              rows="3"
            ></textarea></label
          >
          <label>Author<input bind:value={$draft.metadata.author} /></label>
          <label
            >Version<input
              bind:value={$draft.metadata.version}
              oninput={() => {
                $draft.hosting.tag = `v${$draft.metadata.version}`;
                report = null;
              }}
            /></label
          >
          <label class="wide"
            >Maintainers<input
              bind:value={maintainersText}
              oninput={syncLists}
              placeholder="github-user, second-user"
            /><small>Comma-separated GitHub usernames.</small></label
          >
          <label class="wide"
            >Changelog<textarea bind:value={$draft.metadata.changelog} rows="3"
            ></textarea></label
          >
          <label class="wide"
            >Source repository URL<input
              type="url"
              bind:value={$draft.metadata.sourceUrl}
              placeholder="https://github.com/owner/repository"
            /></label
          >
          <label
            >Icon URL <span class="optional">optional</span><input
              type="url"
              bind:value={$draft.metadata.iconUrl}
            /></label
          >
          <label
            >Screenshots <span class="optional">optional</span><textarea
              bind:value={screenshotsText}
              oninput={syncLists}
              rows="3"
              placeholder="One HTTPS URL per line"
            ></textarea></label
          >
        </div>
        <fieldset>
          <legend>Publishing mode</legend><label class="radio"
            ><input
              type="radio"
              bind:group={$draft.metadata.mode}
              value="built-in"
              onchange={() => (report = null)}
            /><span
              ><strong>Built-in</strong><small
                >GitHub-only, all admission findings block.</small
              ></span
            ></label
          ><label class="radio"
            ><input
              type="radio"
              bind:group={$draft.metadata.mode}
              value="custom"
              onchange={() => (report = null)}
            /><span
              ><strong>Custom repository</strong><small
                >Elevated Lua findings warn; structural findings still block.</small
              ></span
            ></label
          >
        </fieldset>
        <fieldset>
          <legend>Declared capabilities</legend>
          <p class="hint">
            Select explicitly. Scanner suggestions are never added silently.
          </p>
          <div class="checks">
            {#each capabilities as capability (capability)}<label
                ><input
                  type="checkbox"
                  checked={$draft.metadata.declaredCapabilities.includes(
                    capability,
                  )}
                  onchange={() => toggleCapability(capability)}
                />{capability}</label
              >{/each}
          </div>
        </fieldset>
      {:else if step === 2}
        <p class="lede">
          Structural threats always block. Elevated Lua behavior blocks the
          built-in mode and remains prominent in custom reports.
        </p>
        <button class="primary" onclick={runValidation} disabled={busy}
          >Run local validation</button
        >
        {#if report}
          <div
            class:pass={report.structurallyValid}
            class:fail={!report.structurallyValid}
            class="verdict"
          >
            <strong
              >{report.eligibleForScreenedCatalog
                ? 'Eligible for the screened catalog'
                : report.structurallyValid
                  ? 'Structurally valid custom package'
                  : 'Blocked'}</strong
            ><span
              >{report.findings.length} findings · policy v{report.policyVersion}</span
            >
          </div>
          {#if report.suggestedCapabilities.length}<div class="suggestions">
              <strong>Suggested from source</strong>
              <p>{report.suggestedCapabilities.join(', ')}</p>
              <small
                >Suggestions are evidence only. Declare only what the addon
                actually needs.</small
              >
            </div>{/if}
          <ul class="findings">
            {#each report.findings as item, index (`${index}-${item.ruleId}-${item.path ?? ''}`)}<li
                class={item.severity}
              >
                <span>{item.severity}</span>
                <div>
                  <strong>{item.ruleId}</strong>
                  <p>{item.message}</p>
                  {#if item.path}<code
                      >{item.path}{item.line ? `:${item.line}` : ''}</code
                    >{/if}
                </div>
              </li>{/each}{#if !report.findings.length}<li class="clean">
                No findings under the pinned policy.
              </li>{/if}
          </ul>
        {/if}
      {:else if step === 3}
        <fieldset>
          <legend>Artifact host</legend><label class="radio"
            ><input
              type="radio"
              bind:group={$draft.hosting.provider}
              value="github"
            /><span
              ><strong>GitHub Release</strong><small
                >Required for built-in catalog admission.</small
              ></span
            ></label
          ><label class="radio"
            ><input
              type="radio"
              bind:group={$draft.hosting.provider}
              value="generic"
              onchange={() => {
                $draft.metadata.mode = 'custom';
                report = null;
              }}
            /><span
              ><strong>Generic HTTPS</strong><small
                >Provider-neutral custom publishing.</small
              ></span
            ></label
          >
        </fieldset>
        <div class="form-grid">
          {#if $draft.hosting.provider === 'github'}<label
              >Release tag<input
                bind:value={$draft.hosting.tag}
                placeholder="v1.0.0"
              /></label
            ><label class="wide"
              >Expected release asset URL<input
                readonly
                value={expectedUrl}
              /><small
                >Derived locally from source repository, tag, and filename.</small
              ></label
            >{:else}<label class="wide"
              >Artifact URL <span class="optional">optional</span><input
                type="url"
                bind:value={$draft.hosting.artifactUrl}
                placeholder="https://downloads.example/addon.zip"
              /><small>No request will be made to this URL.</small></label
            >{/if}
        </div>
        {#if !$draft.hosting.artifactUrl}<div class="draft-callout">
            <strong>Draft export</strong>
            <p>
              You may export now. The bundle will contain <code
                >catalog-manifest.draft.json</code
              > and cannot be submitted yet.
            </p>
          </div>{/if}
      {:else}
        <p class="lede">
          Download the normalized addon, or a complete handoff bundle with
          metadata, fingerprints, checksums, authorization, report, and
          instructions.
        </p>
        <div class="metrics">
          <div>
            <span>Expected filename</span><strong
              >{artifactFilename($draft.metadata)}</strong
            >
          </div>
          <div>
            <span>Admission</span><strong
              >{report?.eligibleForScreenedCatalog
                ? 'Eligible for screened catalog'
                : report?.structurallyValid
                  ? 'Custom mode only'
                  : 'Validation required'}</strong
            >
          </div>
          <div>
            <span>Hosting</span><strong
              >{$draft.hosting.artifactUrl
                ? 'URL complete'
                : 'Draft—no final URL'}</strong
            >
          </div>
        </div>
        <div class="export-actions">
          <button
            class="primary"
            disabled={!canExport() || busy}
            onclick={exportArtifact}>Download addon ZIP</button
          ><button
            class="secondary"
            disabled={!canExport() || busy}
            onclick={exportBundle}>Download publishing bundle</button
          >
        </div>
        {#if !canExport()}<p class="blocking">
            Return to Validation and resolve all blocking checks before export.
          </p>{/if}
      {/if}

      <div class="panel-actions">
        <button class="ghost" disabled={step === 0} onclick={() => go(step - 1)}
          >Back</button
        >{#if step < 4}<button class="primary" onclick={() => go(step + 1)}
            >Continue</button
          >{/if}
      </div>
    </section>

    <aside>
      <section class="side-card">
        <p class="eyebrow">Privacy boundary</p>
        <h3>Your addon stays here.</h3>
        <p>
          Source bytes live only in memory. Saved drafts contain metadata and
          SHA-256 fingerprints—never files or local paths.
        </p>
      </section>
      <section class="side-card controls">
        <h3>Draft controls</h3>
        <button onclick={exportProject}>Export project JSON</button><button
          onclick={() => importInput.click()}>Import project JSON</button
        ><input
          class="visually-hidden"
          bind:this={importInput}
          type="file"
          accept="application/json,.json"
          onchange={importProject}
        /><button class="danger" onclick={forget}>Forget everything</button>
      </section>
      <section class="side-card contract">
        <span>PINNED CONTRACT</span><code>0123ca9e1d07</code>
        <p>Schema v1 · Policy v1</p>
      </section>
    </aside>
  </div>

  <div class="status" aria-live="polite" aria-atomic="true">
    <span>{status}</span>{#if busy}<progress max="1" value={progress}
      ></progress><button onclick={cancel}>Cancel</button>{/if}
  </div>
</main>

<footer>
  <span>VanaHub Publisher · Browser-only MVP</span><span
    >No accounts · No analytics · No uploads</span
  >
</footer>
