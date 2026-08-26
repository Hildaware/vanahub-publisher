# VanaHub Screenshot Upload Worker

This Worker acts as a secure, temporary bridge between the static Publisher frontend (which runs on GitHub Pages) and the VanaHub catalog. Because the Publisher is a static website, it cannot safely store any secret credentials. Instead, this Cloudflare Worker handles the secure operations: verifying users, signing upload grants, securely receiving images, and serving those images for temporary viewing without exposing the bucket to the public.

## What are we using?

If you are new to Cloudflare, here is a quick overview of the services used:

- **Cloudflare Workers**: Serverless functions that run code (our `index.ts`) on Cloudflare's edge network. They act as our secure API backend.
- **Cloudflare R2**: Cloudflare's S3-compatible object storage. We use a completely private R2 bucket to temporarily store uploaded screenshots.
- **Cloudflare Turnstile**: A privacy-preserving alternative to CAPTCHA. It proves the user uploading images is human. The frontend uses a public "Site Key", and this Worker uses a secret "Secret Key" to verify the result securely.

## Step-by-Step Setup Guide

Follow these steps to configure and deploy the worker.

### 1. Create the R2 Bucket

R2 will store the screenshots. The bucket should remain **completely private** (do not enable public access or R2.dev URLs), as this Worker will handle securely serving the images.

- Log into the Cloudflare Dashboard and navigate to **R2 Object Storage**.
- Create a new bucket named `vanahub-screenshot-staging`.

### 2. Configure Cloudflare Turnstile

Turnstile prevents bots from spamming the upload endpoint.

- In the Cloudflare Dashboard, navigate to **Turnstile**.
- Add a new widget and restrict the domain to your frontend domain (e.g., `hildaware.github.io`).
- Cloudflare will provide you with a **Site Key** (public) and a **Secret Key** (private). Keep the Secret Key handy for step 4.

### 3. Initial Deployment

Before configuring everything, do an initial deployment to generate your Worker's URL. Open your terminal, navigate to the root of the `vanahub-publisher` repository, and run:

```sh
npm install
npx wrangler deploy --config upload-worker/wrangler.toml
```

_(Note: If this is your first time using Wrangler, it will automatically open your web browser and ask you to log into your Cloudflare account to authorize the deployment.)_

Note the URL provided in your terminal (e.g., `https://vanahub-screenshot-upload.<your-username>.workers.dev`).

### 4. Configure `wrangler.toml`

Open `upload-worker/wrangler.toml` and update the variables:

- `PUBLISHER_ORIGIN`: Ensure this matches the exact domain of your frontend (e.g., `https://hildaware.github.io`).
- `PUBLIC_BASE_URL`: Set this to the Worker URL you received in Step 3 (e.g., `https://vanahub-screenshot-upload.<your-username>.workers.dev`).

### 5. Store Secrets Securely

Cloudflare Workers manage secrets separately from code so they are never checked into Git. Run the following commands:

```sh
# Enter the Turnstile Secret Key from Step 2 when prompted
npx wrangler secret put TURNSTILE_SECRET --config upload-worker/wrangler.toml

# Generate a long, random string (e.g. 32+ characters) and enter it when prompted.
# This is used to securely sign upload permissions.
npx wrangler secret put UPLOAD_SIGNING_SECRET --config upload-worker/wrangler.toml

# Generate a separate 32+ character value. Store the same value as the
# VANAHUB_MEDIA_CLEANUP_SECRET secret in the catalog repository.
npx wrangler secret put CLEANUP_SECRET --config upload-worker/wrangler.toml
```

### 6. Set an Auto-Deletion Rule (Lifecycle Rule)

Screenshots are temporary. Catalog automation deletes successfully ingested objects; this lifecycle rule removes abandoned uploads after 30 days.

```sh
npx wrangler r2 bucket lifecycle add \
  vanahub-screenshot-staging expire-pending-uploads pending/ \
  --expire-days 30 --config upload-worker/wrangler.toml
```

### 7. Final Deployment

Deploy the worker once more so it picks up the `PUBLIC_BASE_URL` change.

```sh
npx wrangler deploy --config upload-worker/wrangler.toml
```

### 8. Frontend Configuration (GitHub Pages)

Now, tell the static frontend how to talk to your new Worker and Turnstile.
Go to your Publisher repository's settings on GitHub (Settings > Secrets and variables > Actions > Variables) and add these **Variables** (Not Secrets):

- `VANAHUB_SCREENSHOT_UPLOAD_URL`: Your Worker URL (the same as `PUBLIC_BASE_URL`).
- `VANAHUB_TURNSTILE_SITE_KEY`: The public Turnstile **Site Key** from Step 2.

The GitHub Pages workflow will map these repository variables into Vite build variables for the static site.

---

## Technical Details

The endpoint accepts at most ten PNG, JPEG, or WebP files per verified session, 10 MB per file and 30 MB total. The browser declares each SHA-256 and the Worker verifies it before storing a digest-bound object. Upload grants expire after ten minutes. Anonymous staged responses are non-cacheable downloads; GitHub issue previews use only catalog-normalized bytes pinned to an automation commit. Catalog cleanup can delete only constrained `pending/` keys and lifecycle expiry remains the fallback.
