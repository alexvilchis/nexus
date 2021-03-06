import { stripIndent } from 'common-tags'
import { EOL } from 'os'
import * as Path from 'path'
import { EmitAndSemanticDiagnosticsBuilderProgram } from 'typescript'
import { stripExt } from '../../lib/fs'
import * as Layout from '../../lib/layout'
import { rootLogger } from '../../lib/nexus-logger'
import { transpileModule } from '../../lib/tsc'
import { resolveFrom } from './resolve-from'

const log = rootLogger.child('start-module')

export const START_MODULE_NAME = 'index'
export const START_MODULE_HEADER = 'GENERATED NEXUS START MODULE'

type StartModuleConfig = {
  internalStage: 'build' | 'dev'
  layout: Layout.Layout
  disableArtifactGeneration?: boolean
  absoluteModuleImports?: boolean
  runtimePluginNames: string[]
}

export function createStartModuleContent(config: StartModuleConfig): string {
  log.trace('create start module')
  let content = `// ${START_MODULE_HEADER}` + '\n'

  content += EOL + EOL + EOL
  content += stripIndent`
    process.env.NEXUS_SHOULD_GENERATE_ARTIFACTS = '${!config.disableArtifactGeneration}'
  `

  if (config.internalStage === 'dev') {
    content += EOL + EOL + EOL
    content += stripIndent`
      process.env.NEXUS_STAGE = 'dev'
    `
  }

  content += EOL + EOL + EOL
  content += stripIndent`
    // Run framework initialization side-effects
    // Also, import the app for later use
    const app = require("${
      config.absoluteModuleImports
        ? resolveFrom('nexus', config.layout.projectRoot)
        : 'nexus'
    }").default
  `

  // todo test coverage for this feature
  content += EOL + EOL + EOL
  content += stripIndent`
    // Last resort error handling
    process.once('uncaughtException', error => {
      app.log.fatal('uncaughtException', { error: error })
      process.exit(1)
    })

    process.once('unhandledRejection', error => {
      app.log.fatal('unhandledRejection', { error: error })
      process.exit(1)
    })
  `

  if (config.layout.packageJson) {
    content += EOL + EOL + EOL
    content += stripIndent`
      // package.json is needed for plugin auto-import system.
      // On the Zeit Now platform, builds and dev copy source into
      // new directory. Copying follows paths found in source. Give one here
      // to package.json to make sure Zeit Now brings it along.
      require('${
        config.absoluteModuleImports
          ? config.layout.packageJson.path
          : Path.relative(
              config.layout.buildOutputRelative,
              config.layout.packageJson.path
            )
      }')
    `
  }

  // This MUST come after nexus package has been imported for its side-effects
  const staticImports = printStaticImports(config.layout, {
    absolutePaths: config.absoluteModuleImports,
  })
  if (staticImports !== '') {
    content += EOL + EOL + EOL
    content += stripIndent`
        // Import the user's schema modules
        ${staticImports}
      `
  }

  if (config.layout.app.exists) {
    content += EOL + EOL + EOL
    content += stripIndent`
      // Import the user's app module
      require("${
        config.absoluteModuleImports
          ? stripExt(config.layout.app.path)
          : './' +
            stripExt(config.layout.sourceRelative(config.layout.app.path))
      }")
    `
  }

  if (config.runtimePluginNames.length) {
    const aliasAndPluginNames = config.runtimePluginNames.map((pluginName) => {
      // TODO nice camelcase identifier
      const namedImportAlias = `plugin_${Math.random().toString().slice(2, 5)}`
      return [namedImportAlias, pluginName]
    })
    content += EOL + EOL + EOL
    content += stripIndent`
      // Apply runtime plugins
      ${aliasAndPluginNames
        .map(([namedImportAlias, pluginName]) => {
          return `import { plugin as ${namedImportAlias} } from '${
            config.absoluteModuleImports
              ? resolveFrom(
                  `nexus-plugin-${pluginName}`,
                  config.layout.projectRoot
                )
              : `nexus-plugin-${pluginName}/dist/runtime`
          }'`
        })
        .join(EOL)}

      ${aliasAndPluginNames
        .map(([namedImportAlias, pluginName]) => {
          return `app.__use('${pluginName}', ${namedImportAlias})`
        })
        .join(EOL)}
    `
  }

  content += EOL + EOL + EOL
  content += stripIndent`
    // Boot the server if the user did not already.
    if (app.__state.isWasServerStartCalled === false) {
      app.server.start()
    }  
  `

  log.trace('created', { content })
  return content
}

export function prepareStartModule(
  tsBuilder: EmitAndSemanticDiagnosticsBuilderProgram,
  startModule: string
): string {
  log.trace('Transpiling start module')
  return transpileModule(startModule, tsBuilder.getCompilerOptions())
}

/**
 * Build up static import code for all schema modules in the project. The static
 * imports are relative so that they can be calculated based on source layout
 * but used in build layout.
 *
 * Note that it is assumed the module these imports will run in will be located
 * in the source/build root.
 */
export function printStaticImports(
  layout: Layout.Layout,
  opts?: { absolutePaths?: boolean }
): string {
  return layout.schemaModules.reduce((script, modulePath) => {
    const path = opts?.absolutePaths
      ? stripExt(modulePath)
      : relativeTranspiledImportPath(layout, modulePath)
    return `${script}\n${printSideEffectsImport(path)}`
  }, '')
}

function printSideEffectsImport(modulePath: string): string {
  return `import '${modulePath}'`
}

/**
 * Build up what the import path will be for a module in its transpiled context.
 */
export function relativeTranspiledImportPath(
  layout: Layout.Layout,
  modulePath: string
): string {
  return './' + stripExt(calcSourceRootToModule(layout, modulePath))
}

function calcSourceRootToModule(layout: Layout.Layout, modulePath: string) {
  return Path.relative(layout.sourceRoot, modulePath)
}
