import { expect, test } from "bun:test"
import { inferMode } from "../../src/kernel/buffer"

test("inferMode routes css family extensions", () => {
  expect(inferMode("styles/site.css")).toBe("css-mode")
  expect(inferMode("styles/site.scss")).toBe("scss-mode")
  expect(inferMode("styles/site.sass")).toBe("sass-mode")
})

test("inferMode routes toml files", () => {
  expect(inferMode("pyproject.toml")).toBe("toml-mode")
  expect(inferMode("config/Cargo.toml")).toBe("toml-mode")
})

test("inferMode routes makefiles", () => {
  expect(inferMode("Makefile")).toBe("makefile-mode")
  expect(inferMode("src/makefile")).toBe("makefile-mode")
  expect(inferMode("GNUmakefile")).toBe("makefile-mode")
  expect(inferMode("BSDmakefile")).toBe("makefile-mode")
  expect(inferMode("rules.mk")).toBe("makefile-mode")
})

test("inferMode routes dockerfiles", () => {
  expect(inferMode("Dockerfile")).toBe("dockerfile-mode")
  expect(inferMode("deploy/Dockerfile.prod")).toBe("dockerfile-mode")
  expect(inferMode("app.dockerfile")).toBe("dockerfile-mode")
})

test("inferMode routes c++ extensions and sniffs c headers", () => {
  expect(inferMode("main.cpp")).toBe("c++-mode")
  expect(inferMode("main.cc")).toBe("c++-mode")
  expect(inferMode("util.hpp")).toBe("c++-mode")
  expect(inferMode("util.hh")).toBe("c++-mode")
  expect(inferMode("main.c")).toBe("c")
  expect(inferMode("util.h", "#ifndef UTIL_H\n#define UTIL_H\nint util(void);\n#endif\n")).toBe("c")
  expect(inferMode("empty.h", "")).toBe("c")
  expect(inferMode("namespace.h", "namespace foo {\nint value();\n}\n")).toBe("c++-mode")
  expect(inferMode("class.h", "class Bar {\npublic:\n  int value();\n};\n")).toBe("c++-mode")
  expect(inferMode("string.h", "#include <string>\nstd::string value();\n")).toBe("c++-mode")
})

test("inferMode routes lisp and scheme sources", () => {
  expect(inferMode("core.lisp")).toBe("lisp-mode")
  expect(inferMode("legacy.lsp")).toBe("lisp-mode")
  expect(inferMode("pkg.cl")).toBe("lisp-mode")
  expect(inferMode("lib.scm")).toBe("scheme-mode")
  expect(inferMode("lib.ss")).toBe("scheme-mode")
  expect(inferMode("lib.sld")).toBe("scheme-mode")
  expect(inferMode("init.el")).toBe("emacs-lisp-mode")
})

test("inferMode routes conf-family files", () => {
  expect(inferMode("setup.ini")).toBe("conf-mode")
  expect(inferMode("nginx.conf")).toBe("conf-mode")
  expect(inferMode("app.properties")).toBe("conf-mode")
  expect(inferMode("systemd/foo.service")).toBe("conf-mode")
  expect(inferMode(".env")).toBe("conf-mode")
  expect(inferMode("project/.env.local")).toBe("conf-mode")
  expect(inferMode(".gitconfig")).toBe("conf-mode")
  expect(inferMode("legacy.reg")).toBe("conf-windows-mode")
})

test("inferMode routes xml family files", () => {
  expect(inferMode("pom.xml")).toBe("xml-mode")
  expect(inferMode("icon.svg")).toBe("xml-mode")
  expect(inferMode("Info.plist")).toBe("xml-mode")
  expect(inferMode("feed.rss")).toBe("xml-mode")
  expect(inferMode("page.xhtml")).toBe("xml-mode")
})

test("inferMode routes rst, tex, and bibtex files", () => {
  expect(inferMode("docs/index.rst")).toBe("rst-mode")
  expect(inferMode("paper.tex")).toBe("latex-mode")
  expect(inferMode("macros.sty")).toBe("tex-mode")
  expect(inferMode("article.cls")).toBe("tex-mode")
  expect(inferMode("refs.bib")).toBe("bibtex-mode")
})

test("inferMode routes cmake and go module files", () => {
  expect(inferMode("CMakeLists.txt")).toBe("cmake-mode")
  expect(inferMode("cmake/utils.cmake")).toBe("cmake-mode")
  expect(inferMode("go.mod")).toBe("go-mod-mode")
  expect(inferMode("go.work")).toBe("go-mod-mode")
  expect(inferMode("go.sum")).toBe("go-sum-mode")
  expect(inferMode("main.go")).toBe("go")
})

test("inferMode routes changelog and commit message files", () => {
  expect(inferMode("ChangeLog")).toBe("change-log-mode")
  expect(inferMode("lib/ChangeLog.2")).toBe("change-log-mode")
  expect(inferMode(".git/COMMIT_EDITMSG")).toBe("log-edit-mode")
  expect(inferMode(".git/MERGE_MSG")).toBe("log-edit-mode")
  expect(inferMode(".git/COMMIT_EDITMSG", "diff --git a/x b/x\n")).toBe("diff-mode")
})

test("inferMode still falls back to text", () => {
  expect(inferMode("notes.txt")).toBe("text")
  expect(inferMode("LICENSE")).toBe("text")
})
