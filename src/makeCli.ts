import {Clerc, friendlyErrorPlugin, helpPlugin, notFoundPlugin, strictFlagsPlugin, versionPlugin} from 'clerc'

import mainCommand from './commands/main/command.ts'

const makeCli = (args?: Array<string>) => {
  const packageName = Bun.env.npm_package_name && Bun.env.npm_package_name !== 'exec-mcp' ? Bun.env.npm_package_name : 'savetensors'
  const cli = Clerc.create({
    description: Bun.env.npm_package_description || 'Gitless Hugging Face repository downloader with safetensors shard merging.',
    name: packageName,
    scriptName: packageName,
    version: Bun.env.npm_package_version || '0.1.0',
  })
    .use(helpPlugin())
    .use(versionPlugin())
    .use(notFoundPlugin())
    .use(strictFlagsPlugin())
    .use(friendlyErrorPlugin())
    .command(mainCommand)
  return () => cli.parse(args)
}

export default makeCli
