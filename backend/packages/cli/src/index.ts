import { createCliProgram } from './program.js';

createCliProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
