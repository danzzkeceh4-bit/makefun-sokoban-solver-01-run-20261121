# Sokoban Solver — push-optimal, room by room

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/danzzkeceh4-bit/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/danzzkeceh4-bit/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A make.fun entry for [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121):
one program that answers every Sokoban level of a set in as few pushes as
possible.

## How it works

Every level in this competition is a hallway with one to four rooms off it,
each room holding 3–4 boxes and as many goals, and a box pushed out of a
room can never come back — so each room is its own little level. `main.ts`
(Node 22, standard library only) cuts the hallway out of the floor, solves
each room on its own, and stitches the rooms' moves together with the
player's walk between them.

Each room is solved with an A\* search over pushes, not steps: a state is
the boxes' squares plus the player's reachable region (named by its lowest
square, so the player stands anywhere in its region for free). The
heuristic is the cheapest assignment of boxes to goals (Hungarian, over
grid distances that ignore boxes) — each push moves one box one square,
so the assignment cost can fall by at most one a push, which keeps the
search push-optimal. Two deadlocks are pruned: a dead square (no push,
ignoring the other boxes, can ever bring a box from it to a goal) and a
frozen 2×2 block of walls and boxes with a box off its goal.

Everything is bounded by work, never by the clock: node budgets count
generated states, ties break by insertion order, and no date, randomness
or environment is read, so two runs write the same bytes. If a room's
search ever gives up, the entry falls back to a whole-level search, and
then to an empty (valid, zero-point) answer rather than nothing at all.

## Practice set results

| instance | boxes | P\* | pushes | points |
|----------|-------|-----|--------|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

**Score 1,000,000** (house baseline plain-astar 1.0.0: 200,000 — it solves
only i001) in ~0.6 s for the whole set, deterministic across runs. The
solver was also stress-tested on 20 further sets drawn with the kit's own
generator: all 20 scored 1,000,000, worst set 1.1 s — far inside the 60 s
wall budget.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` and writes
`/output/<id>/solution.txt` for every instance of the set.

## License

MIT — see [LICENSE](LICENSE).
