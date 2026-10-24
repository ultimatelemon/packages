import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Manifest {
  name: string;
  version: string;
  publishConfig?: { access?: string };
}

const OUT = join(import.meta.dirname, 'dist');

function isPublished(name: string, version: string): boolean {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

for (const dir of readdirSync(OUT)) {
  const path = join(OUT, dir);
  const manifest = JSON.parse(
    readFileSync(join(path, 'package.json'), 'utf8')
  ) as Manifest;
  // Font Awesome Pro may not be redistributed: never let one go out public.
  if (manifest.publishConfig?.access !== 'restricted') {
    throw new Error(`${manifest.name} is not restricted, refusing to publish`);
  }
  const id = `${manifest.name}@${manifest.version}`;
  if (isPublished(manifest.name, manifest.version)) {
    process.stdout.write(`${id} is already on npm\n`);
    continue;
  }
  process.stdout.write(`publishing ${id}\n`);
  execFileSync('npm', ['publish', '--access', 'restricted'], {
    cwd: path,
    stdio: 'inherit'
  });
}
