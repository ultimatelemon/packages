import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Style {
  name: string;
  family: string;
  style: string;
  prefix: string;
}

interface Svg {
  width: number;
  height: number;
  path: string | string[];
}

interface Icon {
  unicode: string;
  aliases?: { names?: string[]; unicodes?: { composite?: string[] } };
  svgs?: Record<string, Record<string, Svg>>;
}

const STYLES: Style[] = [
  { name: 'icons-solid', family: 'classic', style: 'solid', prefix: 'fas' },
  { name: 'icons-regular', family: 'classic', style: 'regular', prefix: 'far' },
  { name: 'icons-brands', family: 'classic', style: 'brands', prefix: 'fab' },
  {
    name: 'icons-sharp-solid',
    family: 'sharp',
    style: 'solid',
    prefix: 'fass'
  },
  {
    name: 'icons-sharp-regular',
    family: 'sharp',
    style: 'regular',
    prefix: 'fasr'
  },
  {
    name: 'icons-duotone-solid',
    family: 'duotone',
    style: 'solid',
    prefix: 'fad'
  },
  {
    name: 'icons-duotone-regular',
    family: 'duotone',
    style: 'regular',
    prefix: 'fadr'
  },
  {
    name: 'icons-pixel-regular',
    family: 'pixel',
    style: 'regular',
    prefix: 'fapr'
  }
];

const SCOPE = '@ultimatelemon-eu';
const OUT = join(import.meta.dirname, 'dist');

function exportName(iconName: string): string {
  return (
    'fa' +
    iconName
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
  );
}

function readFromZip(zip: string, pattern: string): string {
  return execFileSync('unzip', ['-p', zip, pattern], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024
  });
}

function findVersion(zip: string): string {
  const listing = execFileSync('unzip', ['-Z1', zip], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  const match = /^fontawesome-pro(?:-plus)?-(\d+\.\d+\.\d+)-web\//m.exec(
    listing
  );
  if (!match) {
    throw new Error(`${zip} is not a Font Awesome Pro web download`);
  }
  return match[1];
}

function buildStyle(
  { name, family, style, prefix }: Style,
  icons: Record<string, Icon>,
  version: string,
  license: string
): number {
  const definitions: string[] = [];
  const declarations: string[] = [];
  const taken = new Set<string>();

  const entries = Object.entries(icons).filter(
    ([, icon]) => icon.svgs?.[family]?.[style]
  );
  for (const [iconName] of entries) taken.add(exportName(iconName));

  for (const [iconName, icon] of entries) {
    const svg = icon.svgs![family][style];
    const aliasNames = icon.aliases?.names ?? [];
    const aliasUnicodes = (icon.aliases?.unicodes?.composite ?? [])
      .map((hex) => parseInt(hex, 16))
      .sort((a, b) => a - b);
    const definition = {
      prefix,
      iconName,
      icon: [
        svg.width,
        svg.height,
        [...aliasUnicodes, ...aliasNames],
        icon.unicode,
        svg.path
      ]
    };
    const primary = exportName(iconName);
    definitions.push(
      `export const ${primary} = ${JSON.stringify(definition)};`
    );
    declarations.push(`export declare const ${primary}: IconDefinition;`);

    for (const alias of aliasNames) {
      const aliasExport = exportName(alias);
      if (taken.has(aliasExport)) continue;
      taken.add(aliasExport);
      definitions.push(`export const ${aliasExport} = ${primary};`);
      declarations.push(`export declare const ${aliasExport}: IconDefinition;`);
    }
  }

  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.js'), definitions.join('\n') + '\n');
  writeFileSync(
    join(dir, 'index.d.ts'),
    "import type { IconDefinition } from '@fortawesome/fontawesome-common-types';\n\n" +
      declarations.join('\n') +
      '\n'
  );
  writeFileSync(join(dir, 'LICENSE.txt'), license);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `${SCOPE}/${name}`,
        version,
        description: `Font Awesome Pro ${version}, ${family} ${style} icons.`,
        license: 'SEE LICENSE IN LICENSE.txt',
        type: 'module',
        sideEffects: false,
        exports: {
          '.': { types: './index.d.ts', default: './index.js' },
          './package.json': './package.json'
        },
        main: './index.js',
        types: './index.d.ts',
        peerDependencies: {
          '@fortawesome/fontawesome-common-types': '>=7.0.0'
        },
        publishConfig: { access: 'restricted' }
      },
      null,
      2
    ) + '\n'
  );
  return entries.length;
}

const zip = process.argv[2];
if (!zip) {
  console.error('usage: npm run icons:build -- <fontawesome-pro-*-web.zip>');
  process.exit(1);
}

const version = findVersion(zip);
const icons = JSON.parse(
  readFromZip(zip, '*/metadata/icon-families.json')
) as Record<string, Icon>;
const license = readFromZip(zip, '*/LICENSE.txt');

rmSync(OUT, { recursive: true, force: true });
for (const style of STYLES) {
  const count = buildStyle(style, icons, version, license);
  process.stdout.write(`${SCOPE}/${style.name}@${version}: ${count} icons\n`);
}
