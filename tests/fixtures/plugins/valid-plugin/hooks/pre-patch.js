export default async function prePatch(...args) {
  return { hook: 'prePatch', plugin: 'valid-plugin', args: args.length };
}
