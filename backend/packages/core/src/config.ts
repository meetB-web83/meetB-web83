import type { PathContext } from './db/paths.js';
import { loadPathContext } from './db/paths.js';

export interface Config {
  workjournalHome: string;
  host: string;
  port: number;
  logLevel: string;
  nodeEnv: string;
  /**
   * Host↔container project-path mapping. Null in native development
   * (PROJECTS_DIRECTORY unset): paths are used exactly as given.
   */
  pathContext: PathContext | null;
}

export function loadConfig(): Config {
  return {
    workjournalHome: process.env.WORKJOURNAL_HOME || '~/.workjournal',
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '3737', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development',
    pathContext: loadPathContext(),
  };
}
