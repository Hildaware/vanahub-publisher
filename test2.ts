import { buildCatalogManifest } from './src/lib/project.js';
console.log(
  buildCatalogManifest(
    {
      id: 'test',
      name: 'test',
      description: 'test',
      author: 'test',
      maintainers: [],
      version: '1',
      changelog: '1',
      sourceUrl: '1',
      iconUrl: 'https://test.com',
      screenshots: ['https://test.com'],
      categories: ['chat-communication'],
      declaredCapabilities: [],
      mode: 'built-in',
    },
    'dl',
    'hash',
    100,
  ),
);
