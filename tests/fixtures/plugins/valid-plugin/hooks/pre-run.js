export default async function preRun(...args) {
  return { hook: 'preRun', plugin: 'valid-plugin', args: args.length };
}
