import { pathToFileURL } from "node:url"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Editor } from "../kernel/editor"
import { runtimeBun } from "../platform/runtime"
import { getLoadPath } from "./load-path"
import * as JemacsRuntime from "./jemacs-runtime"
import { prepareEvalForm } from "./definitions"
import { trackedContext, type PluginContext } from "./plugin-context"

export type InstallFn = (editor: Editor, ctx: PluginContext) => unknown | Promise<unknown>

// Date.now() can repeat across back-to-back reloads; pair it with a counter.
let importSeq = 0

export class Evaluator {
  constructor(private readonly editor: Editor) {}

  async eval(code: string, filename = "jemacs-eval.js"): Promise<unknown> {
    const body = this.transpile(code, filename)
    return await this.runWithRuntime(body, filename)
  }

  async evalExpression(expression: string, filename = "jemacs-expression.js"): Promise<unknown> {
    return await this.eval(`return (${expression})`, filename)
  }

  async evalForm(form: string, filename: string): Promise<unknown> {
    const stripped = prepareEvalForm(form)
    const code = stripped.trimStart().startsWith("editor.")
      || stripped.includes("defcustom(")
      || stripped.includes("defvar(")
      || stripped.includes("defface(")
      || stripped.includes("setFaceAttribute(")
      || stripped.includes("enableBuiltinTheme(")
      || stripped.includes("defineMode(")
      || stripped.includes("addAdvice(")
      || stripped.includes("addHook(")
      ? stripped
      : `(async () => {\n${stripped}\n})()`
    return await this.eval(code, filename)
  }

  private transpile(code: string, filename: string): string {
    if (!filename.endsWith(".ts") && !code.includes(": ") && !code.includes(" as ")) return code
    const bun = runtimeBun() as { Transpiler?: new () => { transformSync: (s: string) => string } }
    if (!bun.Transpiler) return code
    try {
      return new bun.Transpiler().transformSync(code)
    } catch {
      return code
    }
  }

  private async runWithRuntime(body: string, filename: string): Promise<unknown> {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor
    const runtimeNames = Object.keys(JemacsRuntime)
    const fn = new AsyncFunction(
      "editor",
      "console",
      "Buffer",
      "Bun",
      ...runtimeNames,
      `// ${filename}\n${body}\n//# sourceURL=${filename}`,
    )
    return await fn(
      this.editor,
      console,
      Buffer,
      runtimeBun(),
      ...runtimeNames.map(name => (JemacsRuntime as Record<string, unknown>)[name]),
    )
  }

  async loadModule(path: string): Promise<Record<string, unknown>> {
    const full = resolve(path)
    // Bun caches ESM by resolved disk path, ignoring the URL query string,
    // so the ?t= trick that works on Node is a no-op here. Evict explicitly.
    const loader = (globalThis as { Loader?: { registry: Map<string, unknown> } }).Loader
    loader?.registry.delete(full)
    const url = `${pathToFileURL(full).href}?t=${Date.now()}_${importSeq++}`
    return await import(url)
  }

  async loadPlugin(path: string): Promise<unknown> {
    const resolved = this.resolveOnLoadPath(path) ?? resolve(path)
    const mod = await this.loadModule(resolved)
    if (typeof mod.install !== "function") {
      throw new Error(`Plugin ${path} does not export install(editor, ctx)`)
    }
    return await this.installPlugin(resolved, mod.install as InstallFn)
  }

  /** Run an install fn with a tracked context keyed by `key`. Disposes any
   *  prior registration first, so re-install never accumulates hooks/advice.
   *  Boot paths (lisp/, plugins/builtin) call this with statically-imported
   *  modules; loadPlugin calls it with the resolved file path as the key. */
  async installPlugin(key: string, install: InstallFn): Promise<unknown> {
    const ctx = trackedContext(this.editor, key)
    return await install(this.editor, ctx)
  }

  private resolveOnLoadPath(path: string): string | null {
    if (path.startsWith("/") || path.startsWith(".")) return null
    for (const dir of getLoadPath()) {
      const candidate = join(dir, path)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}
