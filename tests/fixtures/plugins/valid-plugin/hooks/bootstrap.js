export default async function bootstrap(...args) {
  return { hook: 'bootstrap', plugin: 'valid-plugin', args: args.length };
}
