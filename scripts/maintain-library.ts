import { parseArgs } from 'node:util';
import { resolveConfiguration } from '../src/core/config.ts';
import { MaintenanceService } from '../src/application/maintenance-service.ts';

const USAGE = 'Usage: pnpm library:maintain <verify|rebuild|backup|restore> [--library DIR] [--config FILE] [--backup DIR]';
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { library: { type: 'string' }, config: { type: 'string' }, backup: { type: 'string' } },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !['verify', 'rebuild', 'backup', 'restore'].includes(command ?? '')) throw new Error(USAGE);
  if ((command === 'backup' || command === 'restore') !== Boolean(values.backup)) throw new Error(USAGE);
  if (command === 'restore' && !values.library) throw new Error('Restore requires an explicit --library NEW_DIRECTORY');
  const configuration = await resolveConfiguration({ libraryDir: values.library, configPath: values.config });
  const service = new MaintenanceService(configuration.libraryDir);
  let result: unknown;
  switch (command) {
    case 'verify': {
      const report = await service.verify();
      result = report;
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'rebuild': result = await service.rebuild(); break;
    case 'backup': result = await service.backup(values.backup!, configuration.config); break;
    case 'restore': result = await service.restore(values.backup!); break;
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Do not echo arbitrary filesystem/JSON errors which may contain private data.
  console.error(error instanceof Error && (error.message === USAGE || error.message.startsWith('Restore requires'))
    ? error.message
    : 'Library maintenance failed. Stop library writers, check paths/permissions and run verify; restore/backup destinations must not exist.');
  process.exitCode = 1;
}
