import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const developmentCsp = {
  name: 'development-csp',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html
      .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
      .replace(
        'connect-src ',
        'connect-src ws://127.0.0.1:* ws://localhost:* ',
      );
  },
};

export default defineConfig({
  base: '/vanahub-publisher/',
  plugins: [svelte(), developmentCsp],
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] },
  },
});
