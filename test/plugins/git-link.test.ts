import { describe, expect, test } from "bun:test"
import { parseRemote, buildGitLink, install as installGitLink } from "../../plugins/git-link"
import { makeEditor } from "./helper"

describe("parseRemote", () => {
  test("parses scp-style ssh remotes", () => {
    expect(parseRemote("git@github.com:owner/repo.git"))
      .toEqual({ host: "github.com", path: "owner/repo" })
  })

  test("parses https remotes", () => {
    expect(parseRemote("https://github.com/owner/repo.git"))
      .toEqual({ host: "github.com", path: "owner/repo" })
  })

  test("parses ssh:// remotes with a user and port", () => {
    expect(parseRemote("ssh://git@git.example.com:2222/team/proj.git"))
      .toEqual({ host: "git.example.com", path: "team/proj" })
  })

  test("keeps nested group paths intact", () => {
    expect(parseRemote("git@gitlab.com:group/sub/proj.git"))
      .toEqual({ host: "gitlab.com", path: "group/sub/proj" })
  })

  test("returns null for junk", () => {
    expect(parseRemote("")).toBeNull()
    expect(parseRemote("not a remote")).toBeNull()
  })
})

describe("buildGitLink", () => {
  const gh = { host: "github.com", path: "owner/repo" }

  test("builds a GitHub blob URL with a line anchor", () => {
    expect(buildGitLink(gh, "main", "src/a.ts", 42))
      .toBe("https://github.com/owner/repo/blob/main/src/a.ts#L42")
  })

  test("uses the GitHub shape for unknown hosts", () => {
    expect(buildGitLink({ host: "git.internal", path: "t/p" }, "master", "a.go", 3))
      .toBe("https://git.internal/t/p/blob/master/a.go#L3")
  })

  test("uses the bitbucket shape", () => {
    expect(buildGitLink({ host: "bitbucket.org", path: "o/r" }, "main", "a.py", 7))
      .toBe("https://bitbucket.org/o/r/src/main/a.py#lines-7")
  })

  test("encodes refs containing slashes", () => {
    expect(buildGitLink(gh, "feature/x", "a.ts", 1))
      .toContain("/blob/feature%2Fx/a.ts#L1")
  })
})

describe("commands", () => {
  test("registers git-link and git-link-commit", () => {
    const editor = makeEditor()
    installGitLink(editor)
    expect(editor.commands.get("git-link")).toBeDefined()
    expect(editor.commands.get("git-link-commit")).toBeDefined()
  })

  test("git-link reports rather than throwing on a non-file buffer", async () => {
    const editor = makeEditor()
    installGitLink(editor)
    editor.currentBuffer.path = undefined
    await editor.run("git-link")
    const messages = [...editor.buffers.values()].find(b => b.name === "*messages*")?.text ?? ""
    expect(messages).toContain("not visiting a file")
  })
})
