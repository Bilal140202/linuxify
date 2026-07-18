export default async function postPatch(...args) {
  return { hook: 'postPatch', plugin: 'valid-plugin', args: args.length };
}
