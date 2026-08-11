# Contributing

Patches are welcome. There is one piece of paperwork, and it exists for a
specific reason worth stating plainly rather than burying.

## Why there is a sign-off at all

Finestra is free for everyone who runs it and licensed for money to people who
build products out of it — see [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).
Selling that second licence requires being able to license the whole codebase,
which means every line in it has to be licensable by one party.

If a contribution arrives with no grant attached, its author keeps their copyright
and the project can no longer offer a commercial licence covering that file
without going back to ask them. Chasing consent from contributors who have since
changed jobs or lost interest is how projects lose years, so the grant is asked
for once, up front, from everyone.

Nothing about it takes anything away from you. You keep your copyright and may
do whatever you like with your own work elsewhere.

## What to do

Add a `Signed-off-by` line to each commit — `git commit -s` writes it for you:

```
Signed-off-by: Your Name <you@example.com>
```

That line means you agree to the two paragraphs below.

## Developer's Certificate of Origin and licence grant

By signing off on a commit, you certify that:

1. You wrote the contribution, or have the right to submit it under these terms,
   and it is not encumbered by anyone else's licence, patent or agreement — in
   particular, that your employer either has no claim to it or has agreed to this.

2. You grant Carlos Bravo a perpetual, worldwide, irrevocable, royalty-free,
   non-exclusive licence to use, reproduce, modify, distribute and sublicense your
   contribution **under any terms, including commercial licence terms**, together
   with a patent licence of the same scope for any patent claims you own that the
   contribution would otherwise infringe. You retain your own copyright and every
   right to use your contribution however you wish.

3. You understand the contribution and this sign-off are public and kept
   indefinitely in the project's history.

If you cannot make grant 2 — many employment contracts are the reason — say so in
the pull request instead of signing off. An issue describing the fix is worth
having even when the patch cannot be taken.

## House style

[`CLAUDE.md`](CLAUDE.md) is the real guide; it is written for an assistant but the
conventions are the project's own. The short version:

- **Comments say why, not what.** The valuable ones record a decision or a failure
  that cost time. Do not narrate the code.
- **Tests read as sentences** and print `PASS`/`FAIL` with a detail. They check
  behaviour, not implementation. They live in `tests/` and are listed in
  `tests/run.sh`.
- **Commit messages carry the reasoning**, wrong turns included. They are the
  handoff to whoever reads this next.
- Prefer deleting to abstracting, and a real check on a real machine to a mock.
- `server/src/services/` is the entire attack surface. A change there deserves a
  paragraph about what it lets a browser do to the machine.

Before opening a pull request:

```bash
npm run typecheck
npm run build && npm test      # the suite needs a build first
make -C compositor             # if you touched compositor/
```

"Things that bite" at the end of `CLAUDE.md` records the failures that have
already cost someone an afternoon. It is worth ten minutes.
