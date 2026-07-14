export default async function doctor(...args) {
  return { hook: 'doctor', plugin: 'valid-plugin', args: args.length };
}
