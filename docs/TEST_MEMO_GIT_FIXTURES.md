# Test memo: git fixtures

How a test suite that spawns git can still earn a [test memo](./TEST_MEMO.md)
record: the `// test-memo: git-fixture` declaration, what the key holds for
such a suite, and what takes the declaration away.

A test that spawns git is refused because nothing in a key says what the
repository looked like: its history, refs, index and working tree are no
file the analyzer hashes. A suite that only drives git inside repositories
it creates under the temp directory has no such input, yet until #18634 it
was refused all the same, and ran on every pull request and every push. No
static reading can prove where `git(dir, ...)` runs, so such a suite says so
with a line comment of its own:

```js
// test-memo: git-fixture
```

The refusal is then replaced by `git` as a keyed tool. What the suite's
verdict depends on, and where the key holds it:

| Input | In the key as |
| --- | --- |
| The suite, the modules it loads, the files they name, installed packages | the `file` and `pkg` lines every key has |
| The git binary | `tool git`: the first line of `git --version` |
| What every repository on the machine inherits: the configuration git reads outside any repository (the system and global files and what `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` supply, includes followed), every file a conditional include names, the global ignore and attributes files and the system-wide attributes file, every `GIT_*` environment variable | a digest in the same `tool git` line (`gitToolIdentity` in `scripts/lib/testMemoRunner.js`; only the digest leaves the function) |
| Node, platform, arch, `TEST_MEMO_ENV` | the environment lines every key has |

Repository state is not in that list because the declaration says there is
none to read. A conditional include (`includeIf`) is read whatever its
condition: the probe runs in no repository, and which conditions a fixture
repository meets depends on where and how the suite makes it. What a setting
points at beyond those files (a hooks or template directory) is the
machine's, as its shell and the rest of its userland are to every key.

Where the runner cannot stand behind the identity, the tool has no version
and nothing is keyed (`TEST_MEMO_REQUIRED_TOOLS`: a required tool is never
keyed as `absent`). A failed probe is never read as an empty answer: git
cannot be run, or is too old to say where a setting came from
(`--show-origin`, 2.8) or where its system-wide attributes are (`git var`,
2.42); the configuration cannot be listed (malformed, unreadable, timed
out); a file it names cannot be placed or read (an ignore file named
relative to each repository, a path under git's own `%(prefix)`); the
include chain does not end; or the temp directory is itself inside a repository, so git started in
a fixture directory that is no repository of its own would find that one.

A product or library module that spawns Git adds the same `tool git` line to
each key that includes it. The test controls the repository state it exercises
through product code. The floor key walks static and lazy imports, while
the recorded key starts with the modules the green run loaded. Reaching a
module does not prove that the suite ran Git, so a key with only this kind of
Git use records an unresolved identity as `tool git absent`. A test's own
accepted fixture declaration still requires a verified Git identity.

The marker is honored for the test file only. A `scripts/` module that
spawns git is repository tooling whatever the importing test declares, and a
git library (`simple-git` and its kind) takes its directory wherever its API
says. Inside the test file the declaration falls, and the suite is refused
as `spawns git (git-fixture declaration refused: …)`, wherever its own text
contradicts it (`scripts/lib/testMemo/gitFixture.js`):

- a git call that is not the literal program `git` with its arguments apart
  (a command line hides the directory it runs in), a git command line
  handed to another program (`sh -c 'git log'`) included. A spawn call is a git
  call when its program can spell git: written in the call, held by the
  name the call reads (`const command = 'git'`, `tool || 'git'`), or passed
  by a caller as that parameter (`run('git', …)` into `(program, args) =>
  spawn(program, args)`). A name the file gives a spawn callee (`const run =
  execFileSync`, `promisify(execFile)`, a renaming import) is a spawn
  callee. The git rule reads the program the same way for a file that
  declares nothing;
- a git call that names no directory: no `cwd` in a literal options object
  with no later spread or computed property that could replace it, and no
  leading `-C <dir>` in a literal argument array. Without one git runs where
  the test process does, inside the checkout;
- a relative literal, or a spelled `null`/`undefined`, that can become that
  directory (git then runs where the test process does, inside the
  checkout): written in place, assigned to a name the directory is read
  from, or the first segment of a `join()`/`resolve()` there. A name
  declared with no value and never assigned is `undefined` too. The
  repository's own `execGit(args, dir)` is read the same way, and a call of
  it with no directory is a git call that names none;
- a caller that gives a git wrapper no fixture directory. Where the
  directory is a parameter of a named function (a declaration, an arrow or
  function bound to a name or a property, a method), every call of that
  function is read: the argument it passes is a directory like any other,
  and an argument it leaves out is `undefined` unless the parameter has a
  default, which is read as an assignment. The same holds for a `{ cwd }`
  pattern and for `options.cwd`, against the object literal each caller
  writes: a literal without the property gives no directory. `.call`,
  `.apply` and `.bind` put the arguments where no call's are, so a function
  that runs git and is reached through one of them is refused outright;
- a repository or home path, or the process directory out of the
  environment (`process.env.PWD`, `INIT_CWD`, `GITHUB_WORKSPACE`), anywhere
  a git process can take it from: inside
  a git call, in the arguments of any call of a function that runs git
  (followed through the functions that call those, and counting the
  repository's own `execGit`), in the iterable of a loop whose variable
  reaches one, or in any value assigned to a name used in one of those
  places. Names are followed by spelling, not by scope, so two
  tests that each declare `repo` are both read. A function that runs git and
  is used other than by a direct call has callers the file does not show;
- a repository directory handed to code the file does not define
  (`commit(process.cwd(), …)`, `{ repoPath: ROOT }`): that is where such
  code runs git, if it runs any.

What stays on the declaration's word is a value the source does not spell: a
call's result, a property of something that is no parameter, the parameter
of a callback (its caller is not this file's to read), an argument behind a
spread, an options object that is no literal, and what another program the
suite starts goes on to run where the line it is handed does not spell git
(a shell script read from a module, a node child). So the marker goes on a
suite only after it has been read end to end, with every repository it makes
accounted for, and it is reviewed as a claim about the suite. Three kinds of
suite stay unmarked even though each git call names a temp directory: one
that reads this checkout another way (`git log` on the repository, a script
of the checkout run through a path the analyzer cannot follow), one whose
verdict needs something no key names (a live Docker engine, the network),
and one that hands real git a machine path it did not create.
The live Docker containment suite depends on the engine and public registry,
so its dedicated workflow runs the suite directly on every selected job.

`server/test/guards/repo/git-fixture-suites.test.js` reads every declaring
suite on every run: a declaration the file contradicts fails there instead
of sending the suite silently back to running on every plan, and each one
must fall when a git call with no directory is added to it.
