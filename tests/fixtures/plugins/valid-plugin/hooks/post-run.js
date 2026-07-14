export default async function postRun(...args) {
  return { hook: 'postRun', plugin: 'valid-plugin', args: args.length };
}
