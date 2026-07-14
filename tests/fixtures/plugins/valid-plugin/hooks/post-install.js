export default async function postInstall(...args) {
  return { hook: 'postInstall', plugin: 'valid-plugin', args: args.length };
}
