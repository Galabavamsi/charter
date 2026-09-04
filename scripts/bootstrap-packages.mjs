import fs from 'node:fs';
import path from 'node:path';

function copyApp(name, port, product, blurb) {
  const src = 'apps/concierge-web';
  const dest = `apps/${name}`;
  const files = [
    'package.json',
    'tsconfig.json',
    'vite.config.ts',
    'index.html',
    'src/main.tsx',
    'src/vite-env.d.ts',
  ];
  for (const file of files) {
    const from = path.join(src, file);
    const to = path.join(dest, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let text = fs.readFileSync(from, 'utf8');
    text = text.replaceAll('@charter/concierge-web', `@charter/${name}`);
    text = text.replaceAll('5173', String(port));
    text = text.replaceAll('Charter Concierge', `Charter ${product}`);
    text = text.replaceAll('product="Concierge"', `product="${product}"`);
    if (file.endsWith('main.tsx')) {
      text = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@charter/ui';
import '@charter/ui/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell product="${product}">
      <p>${blurb}</p>
    </AppShell>
  </StrictMode>,
);
`;
    }
    fs.writeFileSync(to, text);
  }
}

copyApp(
  'register-web',
  5174,
  'Register',
  'Merchant catalog, policy, orders, and approvals. Visual design is not applied yet.',
);
copyApp(
  'control-web',
  5175,
  'Control',
  'Platform health, webhooks, kill switches, and incidents. Visual design is not applied yet.',
);

const modules = [
  'identity',
  'catalog',
  'policy',
  'commerce',
  'payments',
  'orchestrator',
  'growth',
  'recovery',
  'notify',
  'ledger',
];

for (const mod of modules) {
  const dir = path.join('packages', 'modules', mod);
  for (const layer of ['domain', 'application', 'infrastructure', 'interface']) {
    fs.mkdirSync(path.join(dir, 'src', layer), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', layer, 'index.ts'), 'export {};\n');
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@charter/${mod}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
        scripts: {
          build: 'tsc -p tsconfig.json',
          typecheck: 'tsc -p tsconfig.json --noEmit',
          test: 'vitest run --passWithNoTests',
          lint: 'eslint src',
        },
        dependencies: { '@charter/domain-shared': 'workspace:*' },
        devDependencies: { typescript: '^5.7.2', vitest: '^2.1.8' },
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    `export * from './domain/index.js';
export * from './application/index.js';
export * from './infrastructure/index.js';
export * from './interface/index.js';
`,
  );
}

console.log('apps and modules written');
