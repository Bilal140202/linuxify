export default async function preInstall(...args) {
  return { hook: 'preInstall', plugin: 'valid-plugin', args: args.length };
}
