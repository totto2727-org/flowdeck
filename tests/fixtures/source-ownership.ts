import { NodeServices } from '@effect/platform-node'
import { Array, Context, Effect, FileSystem, Layer, Path, Predicate, String } from 'effect'
import { isStringLiteralLikeNode } from 'typescript/ast'
import { API } from 'typescript/sync'

type Dependency = Readonly<{ file: string; target: string }>
type SourceText = Readonly<{ file: string; text: string }>

type ResolveTarget = (file: string, specifier: string) => string | undefined

const makeLocalTarget =
  (path: Path.Path, root: string): ResolveTarget =>
  (file, specifier) => {
    if (String.startsWith('@/')(specifier)) {
      return path.resolve(root, String.slice('@/'.length)(specifier))
    }
    if (String.startsWith('.')(specifier)) {
      return path.resolve(path.dirname(file), specifier)
    }
    return path.isAbsolute(specifier) ? specifier : undefined
  }

const scanDependencies = (
  compiler: API,
  resolveTarget: (file: string, specifier: string) => string | undefined,
  { file, text }: SourceText,
): Dependency[] => {
  using lease = compiler.createSourceFile(file, text)
  return Array.flatMap(lease.sourceFile.imports, (node) => {
    if (!isStringLiteralLikeNode(node)) {
      return []
    }
    const target = resolveTarget(file, node.text)
    return Predicate.isNullish(target) ? [] : [{ file, target }]
  })
}

const parseSources = (
  sources: SourceText[],
  resolveTarget: (file: string, specifier: string) => string | undefined,
): Dependency[] => {
  using compiler = new API()
  return Array.flatMap(sources, (source) => scanDependencies(compiler, resolveTarget, source))
}

const readSources = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const root = path.resolve('src')
  const listed = yield* fs.readDirectory(root, { recursive: true })
  const typeScriptFiles = Array.filter(listed, (file) => Array.contains(['.ts', '.tsx'], path.extname(file)))
  const files = Array.map(typeScriptFiles, (file) => path.resolve(root, file))
  const sources = yield* Effect.forEach(files, (file) =>
    fs.readFileString(file).pipe(Effect.map((text) => ({ file, text }))),
  )
  return { files, root, sources }
})

const example = `import type { Definition } from '@/user-land/definition'
  import { value } from '../../user-land/value'
  export { handler } from '@/bridge/workflow/bridge/worker'
  export * from '@/user-land/exported'
  type Remote = import('@/user-land/type').Remote
  const load = () => import('@/user-land/lazy')`

const inspect = Effect.gen(function* () {
  const path = yield* Path.Path
  const { files, root, sources } = yield* readSources
  const relative = (target: string): string => path.relative(root, target)
  const directories = (target: string): string[] => String.split(relative(target), path.sep)
  const resolveTarget = makeLocalTarget(path, root)
  const within = (target: string, directory: string): boolean => {
    const base = path.resolve(root, directory)
    return target === base || String.startsWith(`${base}${path.sep}`)(target)
  }
  const probe = (): Dependency[] => {
    using compiler = new API()
    const source = { file: path.resolve(root, 'core/feature/boundary-probe.ts'), text: example }
    return scanDependencies(compiler, resolveTarget, source)
  }
  return { dependencies: parseSources(sources, resolveTarget), directories, files, probe, relative, within }
})

export class SourceOwnership extends Context.Service<SourceOwnership, Effect.Success<typeof inspect>>()(
  'flowdeck/test/SourceOwnership',
) {
  public static layer = Layer.effect(this, inspect).pipe(Layer.provide(NodeServices.layer))
}

export type SourceInventory = typeof SourceOwnership.Service
