import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerReadsCommands } from './commands.ts';
import { registerReadsTools } from './tools.ts';

export default function piReadsExtension(pi: ExtensionAPI): void {
  registerReadsTools(pi);
  registerReadsCommands(pi);
}
