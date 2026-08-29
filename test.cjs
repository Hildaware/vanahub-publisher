/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const code = fs.readFileSync('dist-action/index.js', 'utf8');
const match = code.match(/function buildCatalogManifest\(e,t,s,a\)\{.*?\}/);
if (match) {
  const fnStr = match[0];
  const buildCatalogManifest = new Function(
    'e',
    't',
    's',
    'a',
    `
    ${fnStr.replace('function buildCatalogManifest', 'function fn')}
    return fn(e, t, s, a);
  `,
  );
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
      },
      'dl',
      'hash',
      100,
    ),
  );
} else {
  console.log('not found');
}
