import { Command } from 'commander';
const program = new Command();
program
  .command('docker [subcommand] [args...]')
  .allowUnknownOption(true)
  .option('--wake-lock <on|off>', 'wake lock')
  .action((sub, args, opts) => {
    console.log('sub=', sub);
    console.log('args=', args);
    console.log('opts=', JSON.stringify(opts));
  });
program.parse(process.argv);
