<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import {
    capabilities,
    type Capability,
    type GitHubRepository,
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
    stableJson,
    validateMetadata,
  } from './lib/project';
  import {
    addonCandidates,
    archiveWrapper,
    selectedArchiveRoot,
  } from './lib/github';
  import { repositoryProvider } from './lib/repository-provider';
  import {
    bootstrapWorkflow,
    githubNewFileUrl,
    publisherConfig,
  } from './lib/automation';

  const steps = ['Repository', 'Addon details', 'Review', 'Automate'];
  const publisherRef = import.meta.env.VITE_PUBLISHER_REF || 'main';
  const worker = new PublisherWorker();
  let step = 0;
  let entries: SourceEntry[] = [];
  let roots: string[] = [];
  let selectedRoot = '';
  let repositoryUrl = '';
  let repository: GitHubRepository | null = null;
  let wrapper = '';
  let sourcePaths: string[] = [];
  let sourcePath = '.';
  let includedFiles: SourceEntry[] = [];
  let report: ValidationReport | null = null;
  let busy = false;
  let progress = 0;
  let status = 'Paste a public GitHub repository URL to begin.';
  let errors: string[] = [];
  let activeTask: WorkerTask<any> | null = null;
  let heading: HTMLElement;
  let maintainersText = '';
  let screenshotsText = '';

  $: metadataErrors = validateMetadata($draft.metadata);
  $: config = publisherConfig($draft.metadata, repository ? sourcePath : '.');
  $: setupText = repository
    ? bootstrapWorkflow({
        repository: `${repository.owner}/${repository.name}`,
        config,
        maintainers: $draft.metadata.maintainers,
        publisherRef,
      })
    : '';
  $: newFileUrl = repository
    ? githubNewFileUrl(repository.url, repository.defaultBranch)
    : '';
  $: includedFiles = entries.filter((entry) => {
    const prefix = selectedRoot ? `${selectedRoot.replace(/\/$/, '')}/` : '';
    return !entry.directory && (!prefix || entry.path.startsWith(prefix));
  });

  onDestroy(() => worker.close());

  async function go(next: number) {
    step = Math.max(0, Math.min(steps.length - 1, next));
    errors = [];
    await tick();
    heading?.focus();
  }

  async function readArchive(blob: Blob) {
    activeTask = worker.run<SourceEntry[]>(
      { type: 'read-zip', file: blob },
      (value) => (progress = value),
    );
    entries = await activeTask.promise;
  }

  async function inspectRepository() {
    busy = true;
    progress = 0;
    errors = [];
    report = null;
    status = 'Inspecting the GitHub repository…';
    try {
      const provider = repositoryProvider(repositoryUrl);
      if (!provider)
        throw new Error(
          'This host is not automated yet. Use the local folder/ZIP fallback.',
        );
      repository = await provider.inspect(repositoryUrl);
      status = `Fetching commit ${repository.commit.slice(0, 12)}…`;
      entries = await provider.load(repository, (value) => (progress = value));
      wrapper = archiveWrapper(entries);
      sourcePaths = addonCandidates(entries, wrapper);
      if (!sourcePaths.length)
        throw new Error(
          'No Lua addon candidates were found in this repository.',
        );
      sourcePath = sourcePaths[0];
      selectedRoot = selectedArchiveRoot(wrapper, sourcePath);
      roots = [];
      $draft.metadata.sourceUrl = repository.url;
      $draft.metadata.mode = 'built-in';
      status = `Loaded ${repository.owner}/${repository.name} at ${repository.commit.slice(0, 12)}.`;
    } catch (error) {
      repository = null;
      entries = [];
      errors = [(error as Error).message];
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function chooseSourcePath(value: string) {
    sourcePath = value;
    selectedRoot = selectedArchiveRoot(wrapper, value);
    report = null;
  }

  async function ingest(type: 'read-zip' | 'read-directory', files: File[]) {
    if (!files.length) return;
    activeTask?.cancel();
    busy = true;
    progress = 0;
    errors = [];
    report = null;
    repository = null;
    status = 'Reading source locally…';
    try {
      activeTask = worker.run<SourceEntry[]>(
        type === 'read-zip' ? { type, file: files[0] } : { type, files },
        (value) => (progress = value),
      );
      entries = await activeTask.promise;
      const paths = entries
        .filter((entry) => !entry.directory)
        .map((entry) => entry.path);
      roots =
        type === 'read-directory' && paths.some((path) => !path.includes('/'))
          ? []
          : topLevelRoots(paths);
      selectedRoot = roots.length === 1 ? roots[0] : '';
      status = `Loaded ${entries.filter((entry) => !entry.directory).length} local files.`;
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError')
        errors = [(error as Error).message];
    } finally {
      busy = false;
      activeTask = null;
    }
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

  function toggleCapability(capability: Capability) {
    const selected = $draft.metadata.declaredCapabilities;
    $draft.metadata.declaredCapabilities = selected.includes(capability)
      ? selected.filter((item) => item !== capability)
      : [...selected, capability];
    report = null;
  }

  async function runValidation() {
    errors = [...metadataErrors];
    if (!entries.length)
      errors.unshift('Choose a repository or local source first.');
    if (!selectedRoot && roots.length > 1)
      errors.unshift('Select the addon payload root.');
    if (errors.length) return;
    busy = true;
    progress = 0;
    status = 'Validating archive structure and Lua…';
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
      const files = await fingerprints(entries, selectedRoot);
      draft.update((value) => ({
        ...value,
        source: {
          files,
          rootHint: repository ? sourcePath : selectedRoot,
          entrypoint: `${$draft.metadata.id}.lua`,
        },
      }));
      status = nextReport.eligibleForScreenedCatalog
        ? 'All current catalog checks pass.'
        : nextReport.structurallyValid
          ? 'Structurally valid for custom publishing.'
          : 'Validation found blocking problems.';
    } catch (error) {
      errors = [(error as Error).message];
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function canPublish() {
    return (
      !!report &&
      !metadataErrors.length &&
      report.structurallyValid &&
      ($draft.metadata.mode === 'custom' || report.eligibleForScreenedCatalog)
    );
  }

  async function createArtifact() {
    const prefix = selectedRoot ? `${selectedRoot.replace(/\/$/, '')}/` : '';
    const blob = await deterministicZip(
      includedFiles.map((entry) => ({
        path: `${$draft.metadata.id}/${entry.path.slice(prefix.length)}`,
        bytes: entry.bytes,
      })),
    );
    return { blob, digest: await sha256(blob) };
  }

  async function exportArtifact() {
    if (!canPublish()) return;
    const artifact = await createArtifact();
    downloadBlob(artifact.blob, artifactFilename($draft.metadata));
    status = `Addon ZIP ready: ${artifact.digest}`;
  }

  async function exportBundle() {
    if (!canPublish() || !report) return;
    const artifact = await createArtifact();
    const filename = artifactFilename($draft.metadata);
    const manifest = buildCatalogManifest(
      $draft.metadata,
      $draft.hosting.artifactUrl,
      artifact.digest,
      artifact.blob.size,
    );
    const bundle = await deterministicZip([
      {
        path: `artifact/${filename}`,
        bytes: new Uint8Array(await artifact.blob.arrayBuffer()),
      },
      {
        path: 'source-repository/.vanahub.json',
        bytes: stableJson(authorizationTemplate($draft.metadata)),
      },
      {
        path: `catalog/packages/${$draft.metadata.id}/manifest.json`,
        bytes: stableJson(manifest),
      },
      { path: 'validation-report.json', bytes: stableJson(report) },
      { path: 'SHA256SUMS.txt', bytes: `${artifact.digest}  ${filename}\n` },
    ]);
    downloadBlob(bundle, bundleFilename($draft.metadata));
    status = 'Manual publishing kit ready.';
  }

  async function copySetup() {
    await navigator.clipboard.writeText(setupText);
    status = 'Bootstrap workflow copied.';
  }

  function cancel() {
    activeTask?.cancel();
    busy = false;
    status = 'Operation cancelled.';
  }
  function forget() {
    forgetDraft();
    entries = [];
    repository = null;
    repositoryUrl = '';
    roots = [];
    selectedRoot = '';
    report = null;
    maintainersText = '';
    screenshotsText = '';
    status = 'Draft and in-memory source forgotten.';
  }
</script>

<svelte:head
  ><meta
    name="description"
    content="Connect, validate, and automate VanaHub addon publishing."
  /></svelte:head
>

<header class="topbar">
  <a
    class="brand"
    href="/vanahub-publisher/"
    aria-label="VanaHub Publisher home"
    ><span>V</span> VanaHub <b>Publisher</b></a
  >
  <div class="privacy"><i></i> Repository-first · local validation</div>
</header>

<main>
  <section class="hero">
    <p class="eyebrow">Release automation</p>
    <h1>Connect once.<br /><em>Publish every release.</em></h1>
    <p>
      Point VanaHub at your addon repository and install a release-to-catalog
      publishing flow.
    </p>
  </section>
  <nav class="steps" aria-label="Publishing steps">
    {#each steps as label, index (label)}<button
        class:active={step === index}
        class:complete={index < step}
        aria-current={step === index ? 'step' : undefined}
        onclick={() => go(index)}
        ><span>{index < step ? '✓' : index + 1}</span>{label}</button
      >{/each}
  </nav>

  <div class="workspace">
    <section class="panel" aria-labelledby="step-heading">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Step {step + 1} of 4</p>
          <h2 id="step-heading" tabindex="-1" bind:this={heading}>
            {steps[step]}
          </h2>
        </div>
        <span class="mode"
          >{repository ? 'GitHub automation' : 'Local fallback'}</span
        >
      </div>
      {#if errors.length}<div class="error-summary" role="alert">
          <strong>Resolve these items</strong>
          <ul>
            {#each errors as error (error)}<li>{error}</li>{/each}
          </ul>
        </div>{/if}

      {#if step === 0}
        <p class="lede">
          Paste a public GitHub repository. VanaHub inspects an immutable
          snapshot and never stores its source.
        </p>
        <div class="form-grid">
          <label class="wide"
            >GitHub repository URL<input
              type="url"
              bind:value={repositoryUrl}
              placeholder="https://github.com/owner/addon"
            /></label
          >
        </div>
        <button class="primary" onclick={inspectRepository} disabled={busy}
          >Inspect repository</button
        >
        {#if repository}
          <div class="verdict pass">
            <strong>{repository.owner}/{repository.name}</strong><span
              >{repository.defaultBranch} · {repository.commit.slice(
                0,
                12,
              )}</span
            >
          </div>
          <label
            >Addon directory<select
              value={sourcePath}
              onchange={(event) => chooseSourcePath(event.currentTarget.value)}
              >{#each sourcePaths as candidate (candidate)}<option
                  value={candidate}>{candidate}</option
                >{/each}</select
            ><small>Select the directory containing the addon entrypoint.</small
            ></label
          >
          <div class="file-list">
            <div>
              <strong>{includedFiles.length} included files</strong><span
                >{sourcePath}</span
              >
            </div>
            <ul>
              {#each includedFiles as entry (entry.path)}<li>
                  <code>{entry.path.slice(selectedRoot.length + 1)}</code><span
                    >{entry.bytes.byteLength.toLocaleString()} B</span
                  >
                </li>{/each}
            </ul>
          </div>
        {/if}
        <details>
          <summary>Use a local folder or ZIP instead</summary>
          <div class="source-grid">
            <label class="drop"
              ><input
                aria-label="Choose addon folder"
                type="file"
                multiple
                webkitdirectory
                onchange={(event) =>
                  ingest('read-directory', [
                    ...(event.currentTarget.files ?? []),
                  ])}
              /><strong>Choose addon folder</strong><small
                >Uncommitted or self-hosted source</small
              ></label
            >
            <label class="drop"
              ><input
                aria-label="Choose existing ZIP"
                type="file"
                accept=".zip,application/zip"
                onchange={(event) =>
                  ingest('read-zip', [...(event.currentTarget.files ?? [])])}
              /><strong>Choose existing ZIP</strong><small
                >Manual publishing fallback</small
              ></label
            >
          </div>
          {#if roots.length > 1}<label
              >Payload root<select bind:value={selectedRoot}
                ><option value="">Select the addon root…</option
                >{#each roots as root (root)}<option value={root}>{root}</option
                  >{/each}</select
              ></label
            >{/if}
        </details>
      {:else if step === 1}
        <div class="form-grid">
          <label
            >Package ID<input
              bind:value={$draft.metadata.id}
              oninput={() => (report = null)}
              placeholder="my-addon"
            /><small
              >Requires {$draft.metadata.id || '<package-id>'}.lua at the addon
              root.</small
            ></label
          >
          <label>Name<input bind:value={$draft.metadata.name} /></label>
          <label class="wide"
            >Description<textarea
              bind:value={$draft.metadata.description}
              rows="3"
            ></textarea></label
          >
          <label>Author<input bind:value={$draft.metadata.author} /></label>
          <label
            >Maintainers<input
              bind:value={maintainersText}
              oninput={syncLists}
              placeholder="github-user, second-user"
            /><small>Authorized GitHub usernames.</small></label
          >
          {#if !repository}<label
              >Version<input bind:value={$draft.metadata.version} /></label
            ><label class="wide"
              >Source repository URL<input
                type="url"
                bind:value={$draft.metadata.sourceUrl}
              /></label
            >{/if}
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
        {#if !repository}
          <fieldset>
            <legend>Manual publishing destination</legend>
            <label class="radio"
              ><input
                type="radio"
                bind:group={$draft.metadata.mode}
                value="built-in"
                onchange={() => (report = null)}
              /><span
                ><strong>Screened catalog</strong><small
                  >Requires a public GitHub repository and all admission checks.</small
                ></span
              ></label
            >
            <label class="radio"
              ><input
                type="radio"
                bind:group={$draft.metadata.mode}
                value="custom"
                onchange={() => (report = null)}
              /><span
                ><strong>Custom repository</strong><small
                  >Accepts another HTTPS source host; structural checks still
                  block.</small
                ></span
              ></label
            >
          </fieldset>
        {/if}
        <fieldset>
          <legend>Declared capabilities</legend>
          <p class="hint">
            Choose explicitly; scanner suggestions are evidence only.
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
          Run the same structural and Lua policy checks used to prepare catalog
          submissions.
        </p>
        <button class="primary" onclick={runValidation} disabled={busy}
          >Run validation</button
        >
        {#if report}<div
            class:pass={report.eligibleForScreenedCatalog}
            class:fail={!report.eligibleForScreenedCatalog}
            class="verdict"
          >
            <strong
              >{report.eligibleForScreenedCatalog
                ? 'Eligible for the screened catalog'
                : report.structurallyValid
                  ? 'Manual/custom publishing only'
                  : 'Blocked'}</strong
            ><span
              >{report.findings.length} findings · policy v{report.policyVersion}</span
            >
          </div>
          {#if report.suggestedCapabilities.length}<div class="suggestions">
              <strong>Suggested from source</strong>
              <p>{report.suggestedCapabilities.join(', ')}</p>
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
      {:else if repository}
        <p class="lede">
          Add one workflow, run its setup job once, and merge the setup PR. The
          same workflow packages future published GitHub Releases.
        </p>
        <ol>
          <li>Copy the generated workflow.</li>
          <li>
            Commit it as <code>.github/workflows/vanahub-setup.yml</code>.
          </li>
          <li>Run <strong>VanaHub publishing</strong> from Actions.</li>
          <li>
            Review and merge the setup PR. If bot-created PRs are disabled, use
            the run summary's link.
          </li>
        </ol>
        <div class="export-actions">
          <button class="primary" onclick={copySetup} disabled={!canPublish()}
            >Copy setup workflow</button
          ><a
            class="secondary"
            href={newFileUrl}
            target="_blank"
            rel="noreferrer">Open GitHub file editor</a
          >
        </div>
        <label class="wide"
          >Generated publishing workflow<textarea
            readonly
            rows="14"
            value={setupText}
          ></textarea></label
        >
        {#if !canPublish()}<p class="blocking">
            Complete Review and resolve all blocking checks first.
          </p>{/if}
      {:else}
        <p class="lede">
          Local sources cannot install repository automation. Download a
          normalized artifact or manual handoff kit.
        </p>
        <div class="export-actions">
          <button
            class="primary"
            disabled={!canPublish()}
            onclick={exportArtifact}>Download addon ZIP</button
          ><button
            class="secondary"
            disabled={!canPublish()}
            onclick={exportBundle}>Download manual publishing kit</button
          >
        </div>
      {/if}

      <div class="panel-actions">
        <button class="ghost" disabled={step === 0} onclick={() => go(step - 1)}
          >Back</button
        >{#if step < 3}<button class="primary" onclick={() => go(step + 1)}
            >Continue</button
          >{/if}
      </div>
    </section>
    <aside>
      <section class="side-card">
        <p class="eyebrow">Source boundary</p>
        <h3>Your addon stays transient.</h3>
        <p>
          Repository and local source bytes remain in browser memory. Only
          metadata and fingerprints are saved.
        </p>
      </section>
      <section class="side-card">
        <h3>Release contract</h3>
        <p>
          Version comes from the GitHub Release tag. Changelog comes from its
          release notes.
        </p>
      </section>
      <section class="side-card controls">
        <button class="danger" onclick={forget}>Forget everything</button>
      </section>
    </aside>
  </div>
  <div class="status" aria-live="polite" aria-atomic="true">
    <span>{status}</span>{#if busy}<progress max="1" value={progress}
      ></progress><button onclick={cancel}>Cancel</button>{/if}
  </div>
</main>
<footer>
  <span>VanaHub Publisher · GitHub-first automation</span><span
    >No accounts · No analytics · No source storage</span
  >
</footer>
