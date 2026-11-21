// Sokoban solver: push-optimal, room by room.
//
// Idea (standard Sokoban practice, implemented here from scratch):
// a level from this competition is a hallway with one to four rooms off it,
// each room holding 3-4 boxes and as many goals, and a box pushed out of a
// room can never come back, so every room is its own little level. The
// solver cuts the hallway out of the floor, solves each room on its own
// with an A* search over pushes, and stitches the rooms' moves together
// with the player's walk between them.
//
// The search: a state is the boxes' squares plus the player's reachable
// region (named by its lowest square, so the player can stand anywhere in
// its region for free). A step costs one push. The heuristic is the cheapest
// assignment of boxes to goals (Hungarian, by brute force for <= 4 boxes;
// sum of nearest-goal distances otherwise) over grid distances that ignore
// boxes: each push moves one box one square, so the assignment cost can
// fall by at most one a push, which makes it admissible, and the search
// stays push-optimal. Two deadlocks are pruned: a dead square (no push,
// ignoring the other boxes, can ever bring a box from it to a goal) and a
// frozen 2x2 block of walls and boxes with a box off its goal.
//
// Everything is bounded by work, never by the clock: node budgets count
// generated states, ties break by insertion order, and no Date, no
// Math.random and no environment is read, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions: [dx, dy, step letter, push letter], u first on ties.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// ---------------------------------------------------------------- parsing

// XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player,
// + player on a goal) into width, height, walls, goals, boxes and player.
// Short rows and the outer frame count as wall.
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ------------------------------------------------------- shared scratch

// One scratch object per search, so the flood fills reuse their buffers
// instead of allocating on every state.
function makeScratch(size) {
  return {
    seen: new Int32Array(size), // region of the state being expanded
    mark: new Int32Array(size), // region of a state a push makes
    stack: new Int32Array(size),
    stamp: 0,
    mstamp: 0,
    occupied: new Uint8Array(size),
  };
}

// The lowest square the player reaches from `from` around walls and the
// boxes in `occupied`, flood-filling into `seen` under a fresh stamp and
// returning [lowest, stamp]. `seen` keeps the region afterwards, so a
// caller can test whether a square lies in it.
function floodLow(scratch, w, wall, occupied, from) {
  const { seen, stack } = scratch;
  const stamp = ++scratch.stamp;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const a = p - w;
    if (wall[a] === 0 && occupied[a] === 0 && seen[a] !== stamp) { seen[a] = stamp; stack[n++] = a; }
    const b = p + w;
    if (wall[b] === 0 && occupied[b] === 0 && seen[b] !== stamp) { seen[b] = stamp; stack[n++] = b; }
    const c = p - 1;
    if (wall[c] === 0 && occupied[c] === 0 && seen[c] !== stamp) { seen[c] = stamp; stack[n++] = c; }
    const e = p + 1;
    if (wall[e] === 0 && occupied[e] === 0 && seen[e] !== stamp) { seen[e] = stamp; stack[n++] = e; }
  }
  return [low, stamp];
}

// ------------------------------------------------------- static analysis

// The squares from which a box alone can be pushed onto some goal: pull
// back from the goals, a square y live when some live square x = y + d has
// both y and the player's square y - d open floor.
function liveSquares(w, h, wall, goals) {
  const size = w * h;
  const live = new Uint8Array(size);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of [-w, w, -1, 1]) {
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Walking distance from each goal over open floor (walls only, boxes
// ignored), one Int32Array per goal, -1 where unreachable.
function goalDistances(w, h, wall, goals) {
  const size = w * h;
  const out = [];
  for (const g of goals) {
    const dist = new Int32Array(size).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      const a = p - w;
      if (a >= 0 && !wall[a] && dist[a] < 0) { dist[a] = dist[p] + 1; queue.push(a); }
      const b = p + w;
      if (b < size && !wall[b] && dist[b] < 0) { dist[b] = dist[p] + 1; queue.push(b); }
      const c = p - 1;
      if (c >= 0 && !wall[c] && dist[c] < 0) { dist[c] = dist[p] + 1; queue.push(c); }
      const e = p + 1;
      if (e < size && !wall[e] && dist[e] < 0) { dist[e] = dist[p] + 1; queue.push(e); }
    }
    out.push(dist);
  }
  return out;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block: four
// squares of walls and boxes, one of them a box off its goal. A box in
// such a block can never move again.
function frozenBlock(w, wall, occupied, goal, t) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= wall.length) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) ||
        (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// ------------------------------------------------------------ heuristic

// Cheapest assignment of boxes to goals over the grid distances: exact
// (branch and bound over permutations) for up to 4 boxes, the sum of each
// box's nearest goal otherwise. Both are lower bounds on the pushes left.
function heuristic(boxes, dists) {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n <= 4) {
    const used = new Array(n).fill(false);
    let best = Infinity;
    const assign = (i, sum) => {
      if (sum >= best) return;
      if (i === n) {
        best = sum;
        return;
      }
      const b = boxes[i];
      for (let g = 0; g < n; g++) {
        if (used[g]) continue;
        const d = dists[g][b];
        if (d < 0) continue;
        used[g] = true;
        assign(i + 1, sum + d);
        used[g] = false;
      }
    };
    assign(0, 0);
    return best;
  }
  let sum = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const dist of dists) if (dist[b] >= 0 && dist[b] < m) m = dist[b];
    if (m === Infinity) return Infinity;
    sum += m;
  }
  return sum;
}

// ---------------------------------------------------------------- search

// A* over pushes on one (sub-)level: {pushes, moves}, or null when the
// search gives up (no solution, or its state budget spent). `keyOf` turns
// (boxes, region-low) into a map key; `budget` is a shared {used, max}
// counting generated states across the whole run, so a pathological level
// degrades to an empty answer instead of eating the set's wall budget.
function searchPush(sub, budget, keyOf) {
  const { w, h, wall, goals, boxes: startBoxes, player: startPlayer } = sub;
  const size = w * h;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, h, wall, goals);
  const dists = goalDistances(w, h, wall, goals);
  const scratch = makeScratch(size);
  const { occupied } = scratch;
  const solved = (bs) => bs.every((b) => goal[b]);
  if (startBoxes.some((b) => !live[b])) return null;
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  // The states: boxes, player square, region low, parent, the push that
  // made them, pushes so far, and f = g + h. The heap orders by (f, -g, id).
  const sBoxes = [startBoxes.slice()];
  const sPlayer = [startPlayer];
  const sLow = [0];
  const sParent = [-1];
  const sFrom = [-1]; // square the pushed box left
  const sTo = [-1]; // square the pushed box reached
  const sG = [0];
  const sF = [heuristic(startBoxes, dists)];
  const closed = new Map();
  for (const b of startBoxes) occupied[b] = 1;
  const [low0] = floodLow(scratch, w, wall, occupied, startPlayer);
  for (const b of startBoxes) occupied[b] = 0;
  sLow[0] = low0;
  closed.set(keyOf(startBoxes, low0), 0);

  // Binary heap of state ids, smallest (f, -g, id) on top.
  const heap = [0];
  const heapLess = (a, b) =>
    sF[a] < sF[b] || (sF[a] === sF[b] && (sG[a] > sG[b] || (sG[a] === sG[b] && a < b)));
  const heapPush = (id) => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        const t = heap[i];
        heap[i] = heap[c];
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  while (heap.length > 0) {
    const id = heapPop();
    const boxes = sBoxes[id];
    const g = sG[id];
    // A stale heap entry: a better path to this state was found since it
    // was pushed, so skip it.
    if (closed.get(keyOf(boxes, sLow[id])) !== g) continue;
    if (solved(boxes)) {
      found = id;
      break;
    }
    if (budget.used >= budget.max) return null;
    budget.used++;
    for (const b of boxes) occupied[b] = 1;
    const [, stamp] = floodLow(scratch, w, wall, occupied, sPlayer[id]);
    const here = scratch.seen;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        if (here[behind] !== stamp) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, wall, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        // The new state's region, from the square the player stands on
        // after the push (the box's old square), under a second stamp.
        const mstamp = ++scratch.mstamp;
        const { mark, stack } = scratch;
        let low = b;
        let n = 0;
        stack[n++] = b;
        mark[b] = mstamp;
        while (n > 0) {
          const p = stack[--n];
          if (p < low) low = p;
          const a = p - w;
          if (wall[a] === 0 && occupied[a] === 0 && mark[a] !== mstamp) { mark[a] = mstamp; stack[n++] = a; }
          const bb = p + w;
          if (wall[bb] === 0 && occupied[bb] === 0 && mark[bb] !== mstamp) { mark[bb] = mstamp; stack[n++] = bb; }
          const c = p - 1;
          if (wall[c] === 0 && occupied[c] === 0 && mark[c] !== mstamp) { mark[c] = mstamp; stack[n++] = c; }
          const e = p + 1;
          if (wall[e] === 0 && occupied[e] === 0 && mark[e] !== mstamp) { mark[e] = mstamp; stack[n++] = e; }
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const key = keyOf(next, low);
        const prevG = closed.get(key);
        if (prevG === undefined || prevG > g + 1) {
          closed.set(key, g + 1);
          const nid = sBoxes.length;
          sBoxes.push(next);
          sPlayer.push(b);
          sLow.push(low);
          sParent.push(id);
          sFrom.push(b);
          sTo.push(t);
          sG.push(g + 1);
          sF.push(g + 1 + heuristic(next, dists));
          heapPush(nid);
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, push.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const from = sFrom[s];
    const to = sTo[s];
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS.find(([dx, dy]) => dy * w + dx === d)[3];
    player = from;
    boxes = sBoxes[s];
  }
  return { pushes: path.length, moves };
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters (u first on ties). Throws when unreachable: the search only
// ever asks for a square it reached.
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// ------------------------------------------------------------ room split

// The level's rooms: cut the dead squares of the player's row (the
// hallway: a box there reaches no goal) out of the floor, and each part
// left that holds a box is a room, its squares, boxes and goals. Null
// when a part holds more or fewer boxes than goals, or a box starts in
// the hallway: then the level is no set of rooms.
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, h, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// ------------------------------------------------------------ level solve

// Numeric key for a room state: boxes (<= 4, each < 256) and the region's
// lowest square, packed base 256 with 255 padding past the last box.
function roomKeyOf(boxes, low) {
  let k = low;
  for (let i = boxes.length - 1; i >= 0; i--) k = k * 256 + boxes[i];
  for (let i = boxes.length; i < 4; i++) k = k * 256 + 255;
  return k;
}

// String key for a whole-level state (up to 16 boxes: too many to pack).
function levelKeyOf(boxes, low) {
  return boxes.join(',') + '|' + low;
}

// Solve one level room by room in `order` (an array of room indexes):
// each room's push-optimal solution in turn, the other rooms' boxes
// standing as walls (on their goals once their room is done), the player
// walking on from where the last room left it. Null when a room's search
// gives up.
function solveByRooms(level, rooms, order, budget) {
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done = new Array(rooms.length).fill(false);
  for (const ri of order) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of done[oj] ? rooms[oj].goals : rooms[oj].boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = searchPush(sub, budget, roomKeyOf);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done[ri] = true;
  }
  return { pushes, moves };
}

// The square the player stands on after `moves` (case aside) from `from`.
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

// Replay `moves` on the level: true when every step is legal and every
// box ends on a goal.
function verify(level, moves) {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    const d = c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
    const next = player + d;
    if (wall[next]) return false;
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return false;
  return true;
}

// One level's moves: room by room (scan order, then reversed), then a
// whole-level search, then an empty answer (valid format, no points)
// rather than nothing at all.
function solveLevel(text, budget) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null && rooms.length > 0) {
    const orders = [rooms.map((_, i) => i), rooms.map((_, i) => rooms.length - 1 - i)];
    for (const order of orders) {
      const solved = solveByRooms(level, rooms, order, budget);
      if (solved !== null && verify(level, solved.moves)) return solved.moves;
    }
  }
  const whole = searchPush(level, budget, levelKeyOf);
  if (whole !== null && verify(level, whole.moves)) return whole.moves;
  return '';
}

// ------------------------------------------------------------------- main

// Work budget for the whole set, counted in generated states: a level
// that spends it degrades to empty answers, never to a run past the wall.
const BUDGET = { used: 0, max: 8_000_000 };

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), BUDGET);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
