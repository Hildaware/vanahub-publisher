<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import {
    addonCategories,
    type AddonCategory,
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
    releaseAutomation,
    selectedArchiveRoot,
  } from './lib/github';
  import { repositoryProvider } from './lib/repository-provider';
  import {
    bootstrapWorkflow,
    githubNewFileUrl,
    publisherConfig,
    releaseWorkflowIntegration,
  } from './lib/automation';
  import {
    uploadScreenshots,
    validateIconDimensions,
    validateScreenshotFiles,
  } from './lib/screenshots';

  const steps = ['Repository', 'Addon details', 'Review', 'Connect'];
  const categoryLabels: Record<AddonCategory, string> = {
    combat: 'Combat',
    jobs: 'Jobs',
    inventory: 'Inventory',
    crafting: 'Crafting',
    economy: 'Economy',
    'maps-travel': 'Maps & Travel',
    'user-interface': 'User Interface',
    'chat-communication': 'Chat & Communication',
    'data-tracking': 'Data & Tracking',
    'quality-of-life': 'Quality of Life',
    'development-tools': 'Development Tools',
  };
  const publisherRef = import.meta.env.VITE_PUBLISHER_REF || 'main';
  const screenshotUploadUrl = import.meta.env.VITE_SCREENSHOT_UPLOAD_URL || '';
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
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
  let releaseWorkflows: string[] = [];
  const integrationText = releaseWorkflowIntegration();
  let report: ValidationReport | null = null;
  let busy = false;
  let progress = 0;
  let status = '';
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let errors: string[] = [];
  let activeTask: WorkerTask<any> | null = null;
  let heading: HTMLElement;
  let maintainersText = '';
  let screenshotUploading = false;
  let iconUploading = false;
  let turnstileContainer: HTMLElement | null = null;
  let turnstileWidgetId: string | null = null;
  let turnstileToken = '';
  let uploadVerificationToken = '';
  let turnstileLoading: Promise<void> | null = null;

  $: metadataErrors = validateMetadata($draft.metadata);
  $: detailsErrors = [
    ...metadataErrors,
    ...($draft.metadata.categories.length
      ? []
      : ['Choose at least one category.']),
  ];
  $: uploadAuthorized = !!turnstileToken || !!uploadVerificationToken;
  $: sourceComplete =
    entries.some((entry) => !entry.directory) &&
    (roots.length <= 1 || !!selectedRoot);
  $: detailsComplete = sourceComplete && detailsErrors.length === 0;
  $: reviewComplete =
    detailsComplete &&
    !!report &&
    report.structurallyValid &&
    ($draft.metadata.mode === 'custom' || report.eligibleForScreenedCatalog);
  $: unlockedStep = !sourceComplete
    ? 0
    : !detailsComplete
      ? 1
      : !reviewComplete
        ? 2
        : 3;
  $: completedSteps = [sourceComplete, detailsComplete, reviewComplete, false];
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
  $: setupInstalled = entries.some(
    (entry) =>
      !entry.directory &&
      entry.path.toLowerCase().endsWith('.github/workflows/vanahub-setup.yml'),
  );
  $: authorizationInstalled = entries.some(
    (entry) => !entry.directory && entry.path.endsWith('.vanahub.json'),
  );
  $: actionsUrl = repository
    ? `${repository.url}/actions/workflows/vanahub-setup.yml`
    : '';
  $: releaseUrl = repository ? `${repository.url}/releases/new` : '';
  $: catalogIssueUrl = repository
    ? `https://github.com/Hildaware/vanahub-catalog/issues/new?template=vanahub-submission.yml&repository=${encodeURIComponent(repository.url)}&package_id=${encodeURIComponent($draft.metadata.id)}`
    : '';
  $: includedFiles = entries.filter((entry) => {
    const prefix = selectedRoot ? `${selectedRoot.replace(/\/$/, '')}/` : '';
    return !entry.directory && (!prefix || entry.path.startsWith(prefix));
  });
  onDestroy(() => {
    worker.close();
    if (statusTimer) clearTimeout(statusTimer);
    if (turnstileWidgetId) window.turnstile?.remove(turnstileWidgetId);
  });

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Could not load upload verification.'));
      document.head.append(script);
    });
    return turnstileLoading;
  }

  async function renderTurnstile() {
    if (turnstileWidgetId || !turnstileContainer) return;
    await tick();
    try {
      await loadTurnstile();
      if (!turnstileContainer || !window.turnstile) return;
      turnstileWidgetId = window.turnstile.render(turnstileContainer, {
        sitekey: turnstileSiteKey,
        callback: (token) => (turnstileToken = token),
        'expired-callback': () => (turnstileToken = ''),
        'error-callback': () => (turnstileToken = ''),
        theme: 'dark',
      });
    } catch (error) {
      errors = [(error as Error).message];
    }
  }

  function resetTurnstile() {
    turnstileToken = '';
    if (turnstileWidgetId) window.turnstile?.reset(turnstileWidgetId);
  }

  function showStatus(message: string, persistent = false) {
    if (statusTimer) clearTimeout(statusTimer);
    status = message;
    statusTimer = persistent
      ? null
      : setTimeout(() => {
          status = '';
          statusTimer = null;
        }, 5000);
  }

  async function go(next: number) {
    const target = Math.max(0, Math.min(steps.length - 1, next));
    if (!canEnterStep(target)) return;
    step = target;
    errors = [];
    await tick();
    if (target === 1 && screenshotUploadUrl && turnstileSiteKey)
      await renderTurnstile();
    heading?.focus();
  }

  function canEnterStep(target: number) {
    return target <= step || target <= unlockedStep;
  }

  async function continueToNextStep() {
    if (step === 1 && !detailsComplete) {
      errors = [...detailsErrors];
      if (!sourceComplete)
        errors.unshift('Choose a repository or local source first.');
      showStatus('Complete the remaining addon details.');
      heading?.focus();
      return;
    }
    await go(step + 1);
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
    showStatus('Inspecting the GitHub repository…', true);
    try {
      const provider = repositoryProvider(repositoryUrl);
      if (!provider)
        throw new Error(
          'This host is not automated yet. Use the local folder/ZIP fallback.',
        );
      repository = await provider.inspect(repositoryUrl);
      showStatus(`Fetching commit ${repository.commit.slice(0, 12)}…`, true);
      entries = await provider.load(repository, (value) => (progress = value));
      releaseWorkflows = releaseAutomation(entries);
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
      showStatus(
        `Loaded ${repository.owner}/${repository.name} at ${repository.commit.slice(0, 12)}.`,
      );
    } catch (error) {
      repository = null;
      entries = [];
      releaseWorkflows = [];
      errors = [(error as Error).message];
      showStatus('Repository inspection failed.');
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
    releaseWorkflows = [];
    showStatus('Reading source locally…', true);
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
      showStatus(
        `Loaded ${entries.filter((entry) => !entry.directory).length} local files.`,
      );
    } catch (error) {
      if ((error as DOMException).name !== 'AbortError') {
        errors = [(error as Error).message];
        showStatus('Could not read the local source.');
      }
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function syncMaintainers() {
    $draft.metadata.maintainers = maintainersText
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    report = null;
  }

  function clearScreenshots() {
    $draft.metadata.screenshots = [];
    report = null;
  }

  async function selectScreenshots(files: File[]) {
    const problems = validateScreenshotFiles(files, 10);
    if (!screenshotUploadUrl || !turnstileSiteKey)
      problems.unshift('Direct screenshot uploads are not configured yet.');
    else if (!uploadAuthorized)
      problems.unshift('Complete the upload verification first.');
    if (problems.length) {
      errors = problems;
      return;
    }
    screenshotUploading = true;
    errors = [];
    showStatus('Uploading screenshots to temporary storage…', true);
    try {
      const result = await uploadScreenshots(
        screenshotUploadUrl,
        turnstileToken,
        files,
        uploadVerificationToken,
      );
      uploadVerificationToken = result.verificationToken;
      $draft.metadata.screenshots = result.urls;
      report = null;
      showStatus(
        `${result.urls.length} screenshot${result.urls.length === 1 ? '' : 's'} staged for catalog admission.`,
      );
    } catch (error) {
      uploadVerificationToken = '';
      resetTurnstile();
      errors = [(error as Error).message];
      showStatus('Screenshot upload failed.');
    } finally {
      screenshotUploading = false;
      if (!uploadVerificationToken) resetTurnstile();
    }
  }

  async function selectIcon(files: File[]) {
    const problems = validateScreenshotFiles(files, 1);
    if (!problems.length && files[0])
      problems.push(...(await validateIconDimensions(files[0])));
    if (!screenshotUploadUrl || !turnstileSiteKey)
      problems.unshift('Direct file uploads are not configured yet.');
    else if (!uploadAuthorized)
      problems.unshift('Complete the upload verification below first.');
    if (problems.length) {
      errors = problems;
      return;
    }
    iconUploading = true;
    errors = [];
    showStatus('Uploading icon to temporary storage…', true);
    try {
      const result = await uploadScreenshots(
        screenshotUploadUrl,
        turnstileToken,
        files,
        uploadVerificationToken,
      );
      uploadVerificationToken = result.verificationToken;
      if (result.urls.length) $draft.metadata.iconUrl = result.urls[0];
      report = null;
      showStatus('Icon staged for catalog admission.');
    } catch (error) {
      uploadVerificationToken = '';
      resetTurnstile();
      errors = [(error as Error).message];
      showStatus('Icon upload failed.');
    } finally {
      iconUploading = false;
      if (!uploadVerificationToken) resetTurnstile();
    }
  }

  function clearIcon() {
    $draft.metadata.iconUrl = '';
    report = null;
  }

  function toggleCategory(category: AddonCategory) {
    const selected = $draft.metadata.categories;
    if (!selected.includes(category) && selected.length >= 3) return;
    $draft.metadata.categories = selected.includes(category)
      ? selected.filter((item) => item !== category)
      : [...selected, category];
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
    showStatus('Validating archive structure and Lua…', true);
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
      $draft.metadata.declaredCapabilities = nextReport.suggestedCapabilities;
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
      showStatus(
        nextReport.eligibleForScreenedCatalog
          ? nextReport.findings.length
            ? 'Validation passed with warnings.'
            : 'All current catalog checks pass.'
          : nextReport.structurallyValid
            ? 'Structurally valid for custom publishing.'
            : 'Validation found blocking problems.',
      );
    } catch (error) {
      errors = [(error as Error).message];
      showStatus('Validation failed.');
    } finally {
      busy = false;
      activeTask = null;
    }
  }

  function canPublish() {
    return reviewComplete;
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
    showStatus(`Addon ZIP ready: ${artifact.digest}`);
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
    showStatus('Manual publishing kit ready.');
  }

  async function copySetup() {
    await navigator.clipboard.writeText(setupText);
    showStatus('Publishing workflow copied.');
  }

  async function copyIntegration() {
    await navigator.clipboard.writeText(integrationText);
    showStatus('Existing release workflow integration copied.');
  }

  function cancel() {
    activeTask?.cancel();
    busy = false;
    showStatus('Operation cancelled.');
  }
  function forget() {
    forgetDraft();
    entries = [];
    repository = null;
    repositoryUrl = '';
    roots = [];
    releaseWorkflows = [];
    selectedRoot = '';
    report = null;
    maintainersText = '';
    showStatus('Draft and in-memory source forgotten.');
  }
</script>

<svelte:head
  ><meta
    name="description"
    content="Prepare and publish VanaHub addons."
  /></svelte:head
>

<header class="topbar">
  <a
    class="brand"
    href="/vanahub-publisher/"
    aria-label="VanaHub Publisher home"
    ><span>V</span> VanaHub <b>Publisher</b></a
  >
</header>

<main>
  <section class="hero">
    <h1>Publish an addon</h1>
    <p>Prepare and validate an addon for VanaHub.</p>
  </section>
  <nav class="steps" aria-label="Publishing steps">
    {#each steps as label, index (label)}<button
        class:active={step === index}
        class:complete={completedSteps[index]}
        disabled={index > step && index > unlockedStep}
        aria-current={step === index ? 'step' : undefined}
        onclick={() => go(index)}
        ><span>{completedSteps[index] ? '✓' : index + 1}</span>{label}</button
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
              >Payload root<select
                bind:value={selectedRoot}
                onchange={() => (report = null)}
                ><option value="">Select the addon root…</option
                >{#each roots as root (root)}<option value={root}>{root}</option
                  >{/each}</select
              ></label
            >{/if}
        </details>
      {:else if step === 1}
        <div class="form-grid" oninput={() => (report = null)}>
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
              oninput={syncMaintainers}
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
          <fieldset class="media wide">
            <legend>Media</legend>
            {#if screenshotUploadUrl && turnstileSiteKey}<section
                class="media-verification"
                aria-labelledby="verification-label"
              >
                <div class="field-heading">
                  <span id="verification-label">Upload verification</span>
                </div>
                <div
                  class="turnstile"
                  class:verified={!!uploadVerificationToken}
                  bind:this={turnstileContainer}
                ></div>
                {#if uploadVerificationToken}<small class="upload-verified"
                    >Upload verification complete for this page.</small
                  >{/if}
              </section>{:else}<small
                >Media uploads are temporarily unavailable. You can continue
                without optional media.</small
              >{/if}
            <section class="icon-section" aria-labelledby="icon-label">
              <div class="field-heading">
                <span id="icon-label">Icon</span>
                <span class="optional">optional</span>
              </div>
              {#if $draft.metadata.iconUrl}<p class="hint">
                  Icon staged. It will be normalized by catalog admission.
                  <button type="button" class="remove-url" onclick={clearIcon}
                    >Remove</button
                  >
                </p>
                <img
                  class="icon-preview"
                  src={$draft.metadata.iconUrl}
                  alt="Icon preview"
                />{/if}
              {#if screenshotUploadUrl && turnstileSiteKey}<label
                  class:disabled={!uploadAuthorized || iconUploading}
                  class="drop icon-drop"
                  ><input
                    aria-label="Upload icon image"
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    disabled={!uploadAuthorized || iconUploading}
                    onchange={(event) => {
                      void selectIcon([...(event.currentTarget.files ?? [])]);
                      event.currentTarget.value = '';
                    }}
                  /><strong
                    >{iconUploading ? 'Uploading icon…' : 'Upload Icon'}</strong
                  ></label
                >{/if}
              <small
                >Choose a PNG, JPEG, or WebP image no larger than 512×512
                pixels.</small
              >
            </section>
            <section class="screenshots" aria-labelledby="screenshots-label">
              <div class="field-heading">
                <span id="screenshots-label">Screenshots</span>
                <span class="optional">optional</span>
              </div>
              {#if $draft.metadata.screenshots.length}<p class="hint">
                  {$draft.metadata.screenshots.length} screenshot{$draft
                    .metadata.screenshots.length === 1
                    ? ''
                    : 's'} staged. Re-upload the complete desired set to replace them.
                  <button
                    type="button"
                    class="remove-url"
                    onclick={clearScreenshots}>Remove all</button
                  >
                </p>
                <div class="screenshot-previews">
                  {#each $draft.metadata.screenshots as screenshot, index (screenshot)}<figure
                      class="screenshot-preview"
                    >
                      <img
                        src={screenshot}
                        alt={`Screenshot ${index + 1} preview`}
                        loading="lazy"
                      />
                      <figcaption>Screenshot {index + 1}</figcaption>
                    </figure>{/each}
                </div>{/if}
              {#if screenshotUploadUrl && turnstileSiteKey}<label
                  class:disabled={!uploadAuthorized || screenshotUploading}
                  class="drop screenshot-drop"
                  ><input
                    aria-label="Choose screenshot images"
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    multiple
                    disabled={!uploadAuthorized || screenshotUploading}
                    onchange={(event) => {
                      void selectScreenshots([
                        ...(event.currentTarget.files ?? []),
                      ]);
                      event.currentTarget.value = '';
                    }}
                  /><strong
                    >{screenshotUploading
                      ? 'Uploading screenshots…'
                      : 'Choose or drop image files'}</strong
                  ><small
                    >Temporary upload; accepted images move to the catalog.</small
                  ></label
                >{/if}
              <small
                >Upload the complete desired set of up to 10 PNG, JPEG, or WebP
                images.</small
              >
            </section>
          </fieldset>
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
          <legend>Categories</legend>
          <p class="hint">
            Choose 1–3 categories that help players find your addon. Technical
            access is detected automatically during Review.
          </p>
          <div class="checks category-checks">
            {#each addonCategories as category (category)}<label
                ><input
                  type="checkbox"
                  checked={$draft.metadata.categories.includes(category)}
                  disabled={$draft.metadata.categories.length >= 3 &&
                    !$draft.metadata.categories.includes(category)}
                  onchange={() => toggleCategory(category)}
                />{categoryLabels[category]}</label
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
          Complete the one-time connection, then future publishing is just a
          stable release.
        </p>
        <h3>One-time setup</h3>
        <ol>
          <li>{setupInstalled ? '✓ ' : ''}Copy the generated workflow.</li>
          <li>
            Commit it as <code>.github/workflows/vanahub-setup.yml</code>.
          </li>
          <li>
            {authorizationInstalled ? '✓ ' : ''}Run
            <strong>VanaHub publishing</strong> from Actions.
          </li>
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
          ><a
            class="secondary"
            href={actionsUrl}
            target="_blank"
            rel="noreferrer">Open setup workflow</a
          >
        </div>
        <label class="wide"
          >Generated publishing workflow<textarea
            readonly
            rows="14"
            value={setupText}
          ></textarea></label
        >
        <p class="hint">
          To package an existing release manually, run this workflow with its
          <code>release-tag</code> input. Leave it blank only for repository setup.
        </p>
        <h3>First catalog admission</h3>
        <p class="hint">
          After publishing the first stable release, submit the prefilled issue
          once. The issue and catalog PR report validation progress.
        </p>
        <div class="export-actions">
          <a
            class="secondary"
            href={releaseUrl}
            target="_blank"
            rel="noreferrer">Create stable release</a
          >
          <a
            class="secondary"
            href={catalogIssueUrl}
            target="_blank"
            rel="noreferrer">Submit first catalog issue</a
          >
        </div>
        <h3>Every later release</h3>
        <p class="hint">
          Publish a stable SemVer release. Catalog polling discovers it within
          30 minutes; the release workflow summary also links to an optional
          immediate update request.
        </p>
        {#if releaseWorkflows.length}<div class="suggestions">
            <strong>Existing release automation detected</strong>
            <p>
              {releaseWorkflows.join(', ')} creates a release with GitHub Actions.
              Finish the VanaHub setup above first, then connect the existing release
              workflow.
            </p>
            <ol class="integration-steps">
              <li>
                Create and commit
                <code>.github/workflows/vanahub-setup.yml</code>.
              </li>
              <li>Run its setup job and merge the generated setup PR.</li>
              <li>
                Add the job below to the existing release workflow so it calls
                VanaHub after the <code>release</code> job.
              </li>
            </ol>
            <label class="wide"
              >Reusable workflow job<textarea
                readonly
                rows="8"
                value={integrationText}
              ></textarea></label
            >
            <button class="secondary" onclick={copyIntegration}
              >Copy integration job</button
            >
            <small
              >The example assumes a job named <code>release</code> and a
              workflow input named <code>version</code>; adjust those two names
              to match the existing workflow.</small
            >
          </div>{/if}
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
        >{#if step < 3}<button
            class="primary"
            disabled={busy || (step !== 1 && step + 1 > unlockedStep)}
            onclick={continueToNextStep}>Continue</button
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
  {#if status}<div class="status" role="status" aria-atomic="true">
      <span>{status}</span>{#if busy}<progress max="1" value={progress}
        ></progress><button onclick={cancel}>Cancel</button>{/if}
    </div>{/if}
</main>
<footer>
  <span>VanaHub Publisher</span>
</footer>
