export const STORAGE_VERSION = 1;
export const STORAGE_KEY = 'klondike-solitaire-state-v1';
export const DRAW_MODE_KEY = 'klondike-solitaire-draw-mode-v1';
export const SOLVABLE_DEAL_ATTEMPTS = 3;
export const SOLVER_NODE_LIMIT = 4000;
export const SOLVER_DEPTH_LIMIT = 500;

export const SUITS = [
  { id: 'hearts', label: 'Hearts', symbol: '♥', color: 'red' },
  { id: 'diamonds', label: 'Diamonds', symbol: '♦', color: 'red' },
  { id: 'clubs', label: 'Clubs', symbol: '♣', color: 'black' },
  { id: 'spades', label: 'Spades', symbol: '♠', color: 'black' }
];

export const RANKS = [
  { value: 1, short: 'A', label: 'Ace' },
  { value: 2, short: '2', label: 'Two' },
  { value: 3, short: '3', label: 'Three' },
  { value: 4, short: '4', label: 'Four' },
  { value: 5, short: '5', label: 'Five' },
  { value: 6, short: '6', label: 'Six' },
  { value: 7, short: '7', label: 'Seven' },
  { value: 8, short: '8', label: 'Eight' },
  { value: 9, short: '9', label: 'Nine' },
  { value: 10, short: '10', label: 'Ten' },
  { value: 11, short: 'J', label: 'Jack' },
  { value: 12, short: 'Q', label: 'Queen' },
  { value: 13, short: 'K', label: 'King' }
];

const SUIT_IDS = new Set(SUITS.map((suit) => suit.id));
const RANK_VALUES = new Set(RANKS.map((rank) => rank.value));

export function createDeck() {
  return SUITS.flatMap((suit) =>
    RANKS.map((rank) => ({
      id: `${suit.id}-${rank.value}`,
      suit: suit.id,
      rank: rank.value,
      faceUp: false
    }))
  );
}

export function shuffleDeck(deck, random = Math.random) {
  const shuffled = cloneCards(deck);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function dealDeck(deck) {
  const cards = cloneCards(deck);
  const tableau = Array.from({ length: 7 }, () => []);
  let cursor = 0;

  for (let column = 0; column < 7; column += 1) {
    for (let row = 0; row <= column; row += 1) {
      const card = { ...cards[cursor], faceUp: row === column };
      tableau[column].push(card);
      cursor += 1;
    }
  }

  return {
    tableau,
    stock: cards.slice(cursor).map((card) => ({ ...card, faceUp: false })),
    waste: [],
    foundations: emptyFoundations()
  };
}

export function createNewGame({
  random = Math.random,
  drawMode = 1,
  now = Date.now(),
  ensureSolvable = false,
  solvableDealAttempts = SOLVABLE_DEAL_ATTEMPTS
} = {}) {
  const mode = normalizeDrawMode(drawMode);
  const deck = ensureSolvable
    ? createSolvableDeck({ random, drawMode: mode, attempts: solvableDealAttempts })
    : shuffleDeck(createDeck(), random);
  const dealt = dealDeck(deck);
  const initialDeal = clonePiles(dealt);

  return {
    version: STORAGE_VERSION,
    tableau: dealt.tableau,
    stock: dealt.stock,
    waste: dealt.waste,
    foundations: dealt.foundations,
    initialDeal,
    drawMode: mode,
    moves: 0,
    elapsedMs: 0,
    timerRunning: false,
    startedAt: null,
    won: false,
    undoStack: [],
    savedAt: now
  };
}

export function createSolvableDeck({
  random = Math.random,
  drawMode = 3,
  attempts = SOLVABLE_DEAL_ATTEMPTS,
  solverNodeLimit = SOLVER_NODE_LIMIT
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const deck = shuffleDeck(createDeck(), random);
    const candidate = stateFromDeal(dealDeck(deck), normalizeDrawMode(drawMode));
    if (isDealSolvable(candidate, { drawMode, nodeLimit: solverNodeLimit }).solvable) {
      return deck;
    }
  }

  return createGuaranteedSolvableDeck(random);
}

export function createGuaranteedSolvableDeck(random = Math.random) {
  const suitOrder = shuffleDeck(
    SUITS.map((suit) => ({ id: suit.id, suit: suit.id, rank: 1, faceUp: false })),
    random
  ).map((card) => card.suit);
  const patterns = shuffleDeck(
    [
      [7],
      [1, 6],
      [2, 5],
      [3, 4]
    ].map((lengths, index) => ({ id: `pattern-${index}`, lengths })),
    random
  ).map((pattern) => (random() < 0.5 ? [...pattern.lengths].reverse() : pattern.lengths));

  const segments = [];
  for (let suitIndex = 0; suitIndex < suitOrder.length; suitIndex += 1) {
    let nextRank = 7;
    for (const length of patterns[suitIndex]) {
      const endRank = nextRank + length - 1;
      segments.push(rankSegment(suitOrder[suitIndex], nextRank, endRank));
      nextRank = endRank + 1;
    }
  }

  const columns = Array.from({ length: 7 }, (_, index) => segments.find((segment) => segment.length === index + 1));
  const stock = [];

  for (let rank = 1; rank <= 6; rank += 1) {
    for (const suit of suitOrder) stock.push(makeCard(suit, rank));
  }

  return [...columns.flat(), ...stock];
}

export function restartSameDeal(state, { now = Date.now() } = {}) {
  const initial = clonePiles(state.initialDeal);
  return {
    version: STORAGE_VERSION,
    tableau: initial.tableau,
    stock: initial.stock,
    waste: initial.waste,
    foundations: initial.foundations,
    initialDeal: clonePiles(state.initialDeal),
    drawMode: normalizeDrawMode(state.drawMode),
    moves: 0,
    elapsedMs: 0,
    timerRunning: false,
    startedAt: null,
    won: false,
    undoStack: [],
    savedAt: now
  };
}

export function setDrawMode(state, drawMode, { now = Date.now() } = {}) {
  return {
    ...cloneState(state),
    drawMode: normalizeDrawMode(drawMode),
    savedAt: now
  };
}

export function drawStock(state, { now = Date.now() } = {}) {
  if (state.won) return fail(state, 'This deal is already won.');
  if (state.stock.length === 0 && state.waste.length === 0) {
    return fail(state, 'Stock and waste are empty.');
  }

  const next = cloneState(state);
  next.undoStack.push(createSnapshot(state));

  let action = 'draw';
  if (next.stock.length === 0) {
    next.stock = next.waste.map((card) => ({ ...card, faceUp: false }));
    next.waste = [];
    action = 'recycle';
  } else {
    const drawCount = Math.min(next.drawMode, next.stock.length);
    const drawn = next.stock.splice(0, drawCount).map((card) => ({ ...card, faceUp: true }));
    next.waste.push(...drawn);
  }

  completeAction(next, 1, now);
  return { ok: true, state: next, action };
}

export function moveCards(state, source, target, { now = Date.now(), recordUndo = true, countMove = true } = {}) {
  if (state.won) return fail(state, 'This deal is already won.');

  const validation = canMove(state, source, target);
  if (!validation.ok) return fail(state, validation.reason);

  const next = cloneState(state);
  if (recordUndo) next.undoStack.push(createSnapshot(state));

  applyMoveWithoutUndo(next, source, target);
  if (countMove) completeAction(next, 1, now);

  return {
    ok: true,
    state: next,
    movedCards: validation.cards.length
  };
}

export function undo(state, { now = Date.now() } = {}) {
  if (!state.undoStack.length) return fail(state, 'Nothing to undo.');
  const undoStack = cloneDeep(state.undoStack);
  const snapshot = undoStack.pop();
  return {
    ok: true,
    state: {
      ...cloneDeep(snapshot),
      version: STORAGE_VERSION,
      drawMode: normalizeDrawMode(state.drawMode),
      undoStack,
      savedAt: now
    }
  };
}

export function autoMoveToFoundation(state, source, { now = Date.now() } = {}) {
  const card = getSingleFoundationPlayableCard(state, source);
  if (!card) return fail(state, 'Only a playable single card can move to a foundation.');
  const suit = findFoundationTargetForCard(state, card);
  if (!suit) return fail(state, `${cardName(card)} cannot move to a foundation yet.`);
  return moveCards(state, source, { type: 'foundation', suit }, { now });
}

export function getBestMoveForSource(state, source) {
  return legalMovesForSource(state, source)[0] || null;
}

export function legalMovesForSource(state, source) {
  if (state.won) return [];
  const cards = getMovableCards(state, source);
  if (!cards.length) return [];

  const foundationMoves = [];
  const revealingTableauMoves = [];
  const tableauMoves = [];

  if (source.type !== 'foundation') {
    for (const suit of SUITS) {
      const target = { type: 'foundation', suit: suit.id };
      if (canMove(state, source, target).ok) {
        foundationMoves.push({ kind: 'move', source, target });
      }
    }
  }

  for (let column = 0; column < 7; column += 1) {
    const target = { type: 'tableau', column };
    if (!canMove(state, source, target).ok) continue;

    const move = { kind: 'move', source, target };
    if (source.type === 'tableau' && source.index > 0 && state.tableau[source.column][source.index - 1]?.faceUp === false) {
      revealingTableauMoves.push(move);
    } else {
      tableauMoves.push(move);
    }
  }

  return [...foundationMoves, ...revealingTableauMoves, ...tableauMoves];
}

export function autoComplete(state, { now = Date.now() } = {}) {
  if (state.won) return fail(state, 'This deal is already won.');
  const plan = getAutoCompletePlan(state);
  if (!plan.canComplete) return fail(state, 'Auto-complete is not safe yet.');

  const next = cloneState(state);
  next.undoStack.push(createSnapshot(state));
  for (const move of plan.moves) {
    applyMoveWithoutUndo(next, move.source, move.target);
  }
  completeAction(next, plan.moves.length, now);
  return { ok: true, state: next, movedCards: plan.moves.length };
}

export function getAutoCompletePlan(state) {
  if (state.won) return { canComplete: false, moves: [] };
  if (state.stock.length > 0 || hasFaceDownTableauCards(state)) {
    return { canComplete: false, moves: [] };
  }

  const simulation = cloneState(state);
  simulation.undoStack = [];
  const moves = [];
  let guard = 0;

  while (!checkWin(simulation) && guard < 104) {
    const move = findNextFoundationMove(simulation);
    if (!move) return { canComplete: false, moves: [] };
    applyMoveWithoutUndo(simulation, move.source, move.target);
    moves.push(move);
    guard += 1;
  }

  return { canComplete: checkWin(simulation), moves };
}

export function getHint(state) {
  const hints = getHints(state);
  if (!hints.available) return hints;
  return hints.moves[0];
}

export function getHints(state) {
  if (state.won) return { available: false, message: 'This deal is already won.', moves: [] };
  const moves = hintMoves(state).map((move) => {
    const target = move.kind === 'stock' ? { type: 'stock' } : move.target;
    return {
      available: true,
      source: move.source || null,
      target,
      message: describeHint(state, move),
      key: hintMoveKey(move)
    };
  });
  if (!moves.length) return { available: false, message: 'No legal moves are available.', moves: [] };
  return {
    available: true,
    message: moves[0].message,
    moves
  };
}

export function isDealSolvable(
  state,
  {
    drawMode = 3,
    nodeLimit = SOLVER_NODE_LIMIT,
    depthLimit = SOLVER_DEPTH_LIMIT
  } = {}
) {
  const start = cloneState({
    ...state,
    drawMode: normalizeDrawMode(drawMode),
    undoStack: []
  });
  const seen = new Set();
  let nodes = 0;

  function search(current, depth) {
    nodes += 1;
    if (checkWin(current)) return true;
    if (nodes > nodeLimit || depth > depthLimit) return false;

    const key = solverStateKey(current);
    if (seen.has(key)) return false;
    seen.add(key);

    for (const move of solverMoves(current)) {
      const next = applySolverMove(current, move);
      if (search(next, depth + 1)) return true;
    }

    return false;
  }

  const solvable = search(start, 0);
  return { solvable, nodes, exhausted: nodes > nodeLimit };
}

export function canMove(state, source, target) {
  if (!source || !target) return { ok: false, reason: 'Choose a card and a destination.', cards: [] };
  if (source.type === 'tableau' && target.type === 'tableau' && source.column === target.column) {
    return { ok: false, reason: 'Choose a different tableau column.', cards: [] };
  }
  if (source.type === 'foundation' && target.type === 'foundation') {
    return { ok: false, reason: 'Foundation cards can move only to the tableau.', cards: [] };
  }

  const cards = getMovableCards(state, source);
  if (cards.length === 0) {
    return { ok: false, reason: 'That card cannot be moved.', cards: [] };
  }

  if (target.type === 'tableau') {
    const destination = state.tableau[target.column];
    if (!destination) return { ok: false, reason: 'Choose a tableau column.', cards };
    if (!canPlaceOnTableau(cards, destination)) {
      return { ok: false, reason: tableauReason(cards, destination), cards };
    }
    return { ok: true, reason: '', cards };
  }

  if (target.type === 'foundation') {
    if (source.type === 'foundation') {
      return { ok: false, reason: 'Foundation cards can move only to the tableau.', cards };
    }
    if (cards.length !== 1 || !isSourceTopCard(state, source)) {
      return { ok: false, reason: 'Only a top single card can move to a foundation.', cards };
    }
    const foundation = state.foundations[target.suit];
    if (!foundation) return { ok: false, reason: 'Choose a foundation.', cards };
    if (!canPlaceOnFoundation(cards[0], foundation, target.suit)) {
      return { ok: false, reason: `${cardName(cards[0])} cannot move to that foundation.`, cards };
    }
    return { ok: true, reason: '', cards };
  }

  return { ok: false, reason: 'Choose a valid destination.', cards };
}

export function getMovableCards(state, source) {
  if (!source) return [];

  if (source.type === 'waste') {
    const top = topCard(state.waste);
    return top ? [top] : [];
  }

  if (source.type === 'foundation') {
    const pile = state.foundations[source.suit];
    const top = pile ? topCard(pile) : null;
    return top ? [top] : [];
  }

  if (source.type === 'tableau') {
    const pile = state.tableau[source.column];
    if (!pile) return [];
    const index = source.index ?? pile.length - 1;
    const cards = pile.slice(index);
    return isValidTableauSequence(cards) ? cards : [];
  }

  return [];
}

export function isValidTableauSequence(cards) {
  if (!cards.length || cards.some((card) => !card.faceUp)) return false;
  for (let index = 0; index < cards.length - 1; index += 1) {
    const current = cards[index];
    const next = cards[index + 1];
    if (current.rank !== next.rank + 1) return false;
    if (cardColor(current) === cardColor(next)) return false;
  }
  return true;
}

export function canPlaceOnTableau(cards, destination) {
  if (!isValidTableauSequence(cards)) return false;
  const lead = cards[0];
  const target = topCard(destination);
  if (!target) return lead.rank === 13;
  return target.faceUp && target.rank === lead.rank + 1 && cardColor(target) !== cardColor(lead);
}

export function canPlaceOnFoundation(card, foundation, suit) {
  if (!card?.faceUp || card.suit !== suit) return false;
  const target = topCard(foundation);
  if (!target) return card.rank === 1;
  return target.suit === card.suit && card.rank === target.rank + 1;
}

export function checkWin(state) {
  return SUITS.every((suit) => state.foundations[suit.id]?.length === 13) && countFoundationCards(state) === 52;
}

export function countFoundationCards(state) {
  return SUITS.reduce((total, suit) => total + (state.foundations[suit.id]?.length || 0), 0);
}

export function hasFaceDownTableauCards(state) {
  return state.tableau.some((pile) => pile.some((card) => !card.faceUp));
}

export function getElapsedMs(state, now = Date.now()) {
  if (!state.timerRunning || state.startedAt == null || state.won) return state.elapsedMs;
  return state.elapsedMs + Math.max(0, now - state.startedAt);
}

export function saveState(storage, state, { now = Date.now() } = {}) {
  const saved = {
    ...cloneState(state),
    savedAt: now
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  storage.setItem(DRAW_MODE_KEY, String(normalizeDrawMode(state.drawMode)));
}

export function loadState(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return deserializeState(raw);
}

export function loadDrawModePreference(storage) {
  return normalizeDrawMode(Number(storage.getItem(DRAW_MODE_KEY) || 1));
}

export function deserializeState(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const state = normalizeState(parsed);
    return validateState(state) ? state : null;
  } catch {
    return null;
  }
}

export function serializeState(state) {
  return JSON.stringify(cloneState(state));
}

export function cloneState(state) {
  return {
    version: STORAGE_VERSION,
    tableau: state.tableau.map(cloneCards),
    stock: cloneCards(state.stock),
    waste: cloneCards(state.waste),
    foundations: cloneFoundations(state.foundations),
    initialDeal: clonePiles(state.initialDeal),
    drawMode: normalizeDrawMode(state.drawMode),
    moves: Number(state.moves) || 0,
    elapsedMs: Number(state.elapsedMs) || 0,
    timerRunning: Boolean(state.timerRunning),
    startedAt: state.startedAt == null ? null : Number(state.startedAt),
    won: Boolean(state.won),
    undoStack: cloneDeep(state.undoStack || []),
    savedAt: Number.isFinite(Number(state.savedAt)) ? Number(state.savedAt) : Date.now()
  };
}

export function rankShort(rank) {
  return RANKS.find((item) => item.value === rank)?.short || String(rank);
}

export function rankLabel(rank) {
  return RANKS.find((item) => item.value === rank)?.label || String(rank);
}

export function suitInfo(suitId) {
  return SUITS.find((suit) => suit.id === suitId);
}

export function suitLabel(suitId) {
  return suitInfo(suitId)?.label || suitId;
}

export function cardColor(card) {
  return suitInfo(card.suit)?.color || 'black';
}

export function cardName(card) {
  return `${rankLabel(card.rank)} of ${suitLabel(card.suit)}`;
}

export function cardAriaLabel(card) {
  return card.faceUp ? `${cardName(card)}, face up` : 'Face-down card';
}

function applyMoveWithoutUndo(state, source, target) {
  const moving = removeCards(state, source);

  if (target.type === 'tableau') {
    state.tableau[target.column].push(...moving.map((card) => ({ ...card, faceUp: true })));
  } else if (target.type === 'foundation') {
    state.foundations[target.suit].push({ ...moving[0], faceUp: true });
  }

  flipExposedTableauCard(state, source);
}

function applySolverMove(state, move) {
  const next = cloneState(state);
  next.undoStack = [];

  if (move.kind === 'stock') {
    if (next.stock.length === 0) {
      next.stock = next.waste.map((card) => ({ ...card, faceUp: false }));
      next.waste = [];
    } else {
      const drawCount = Math.min(next.drawMode, next.stock.length);
      next.waste.push(...next.stock.splice(0, drawCount).map((card) => ({ ...card, faceUp: true })));
    }
  } else {
    applyMoveWithoutUndo(next, move.source, move.target);
  }

  next.won = checkWin(next);
  return next;
}

function solverMoves(state) {
  const foundationMoves = [];
  const revealingTableauMoves = [];
  const wasteTableauMoves = [];
  const tableauMoves = [];
  const foundationTableauMoves = [];

  const wasteCard = topCard(state.waste);
  if (wasteCard) {
    if (canPlaceOnFoundation(wasteCard, state.foundations[wasteCard.suit], wasteCard.suit)) {
      foundationMoves.push({ kind: 'move', source: { type: 'waste' }, target: { type: 'foundation', suit: wasteCard.suit } });
    }

    for (let column = 0; column < 7; column += 1) {
      if (canPlaceOnTableau([wasteCard], state.tableau[column])) {
        wasteTableauMoves.push({ kind: 'move', source: { type: 'waste' }, target: { type: 'tableau', column } });
      }
    }
  }

  for (let column = 0; column < 7; column += 1) {
    const pile = state.tableau[column];
    const top = topCard(pile);
    if (top?.faceUp && canPlaceOnFoundation(top, state.foundations[top.suit], top.suit)) {
      foundationMoves.push({
        kind: 'move',
        source: { type: 'tableau', column, index: pile.length - 1 },
        target: { type: 'foundation', suit: top.suit }
      });
    }

    const firstFaceUp = pile.findIndex((card) => card.faceUp);
    if (firstFaceUp === -1) continue;

    for (let index = firstFaceUp; index < pile.length; index += 1) {
      const cards = pile.slice(index);
      if (!isValidTableauSequence(cards)) continue;

      for (let targetColumn = 0; targetColumn < 7; targetColumn += 1) {
        if (targetColumn === column || !canPlaceOnTableau(cards, state.tableau[targetColumn])) continue;
        if (state.tableau[targetColumn].length === 0 && index === 0) continue;

        const move = {
          kind: 'move',
          source: { type: 'tableau', column, index },
          target: { type: 'tableau', column: targetColumn }
        };

        if (index > 0 && !pile[index - 1].faceUp) {
          revealingTableauMoves.push(move);
        } else {
          tableauMoves.push(move);
        }
      }
    }
  }

  for (const suit of SUITS) {
    const card = topCard(state.foundations[suit.id]);
    if (!card) continue;
    for (let column = 0; column < 7; column += 1) {
      if (canPlaceOnTableau([card], state.tableau[column])) {
        foundationTableauMoves.push({ kind: 'move', source: { type: 'foundation', suit: suit.id }, target: { type: 'tableau', column } });
      }
    }
  }

  const stockMove = state.stock.length > 0 || state.waste.length > 0 ? [{ kind: 'stock' }] : [];
  return [
    ...foundationMoves,
    ...revealingTableauMoves,
    ...wasteTableauMoves,
    ...tableauMoves,
    ...foundationTableauMoves,
    ...stockMove
  ];
}

function hintMoves(state) {
  const foundationMoves = [];
  const revealingTableauMoves = [];
  const freeingFoundationMoves = [];
  const wasteTableauMoves = [];
  const tableauMoves = [];
  const foundationTableauMoves = [];

  const wasteCard = topCard(state.waste);
  if (wasteCard) {
    if (canPlaceOnFoundation(wasteCard, state.foundations[wasteCard.suit], wasteCard.suit)) {
      foundationMoves.push({ kind: 'move', source: { type: 'waste' }, target: { type: 'foundation', suit: wasteCard.suit } });
    }

    for (let column = 0; column < 7; column += 1) {
      if (canPlaceOnTableau([wasteCard], state.tableau[column])) {
        wasteTableauMoves.push({ kind: 'move', source: { type: 'waste' }, target: { type: 'tableau', column } });
      }
    }
  }

  for (let column = 0; column < 7; column += 1) {
    const pile = state.tableau[column];
    const top = topCard(pile);
    if (top?.faceUp && canPlaceOnFoundation(top, state.foundations[top.suit], top.suit)) {
      foundationMoves.push({
        kind: 'move',
        source: { type: 'tableau', column, index: pile.length - 1 },
        target: { type: 'foundation', suit: top.suit }
      });
    }

    const firstFaceUp = pile.findIndex((card) => card.faceUp);
    if (firstFaceUp === -1) continue;

    for (let index = firstFaceUp; index < pile.length; index += 1) {
      const cards = pile.slice(index);
      if (!isValidTableauSequence(cards)) continue;

      for (let targetColumn = 0; targetColumn < 7; targetColumn += 1) {
        if (targetColumn === column || !canPlaceOnTableau(cards, state.tableau[targetColumn])) continue;

        const move = {
          kind: 'move',
          source: { type: 'tableau', column, index },
          target: { type: 'tableau', column: targetColumn }
        };
        const exposed = index > 0 ? pile[index - 1] : null;

        if (exposed && !exposed.faceUp) {
          revealingTableauMoves.push(move);
        } else if (exposed && canPlaceOnFoundation(exposed, state.foundations[exposed.suit], exposed.suit)) {
          freeingFoundationMoves.push(move);
        } else {
          tableauMoves.push(move);
        }
      }
    }
  }

  for (const suit of SUITS) {
    const card = topCard(state.foundations[suit.id]);
    if (!card) continue;
    for (let column = 0; column < 7; column += 1) {
      if (canPlaceOnTableau([card], state.tableau[column])) {
        foundationTableauMoves.push({ kind: 'move', source: { type: 'foundation', suit: suit.id }, target: { type: 'tableau', column } });
      }
    }
  }

  const stockMove = state.stock.length > 0 || state.waste.length > 0 ? [{ kind: 'stock' }] : [];
  return [
    ...foundationMoves,
    ...revealingTableauMoves,
    ...freeingFoundationMoves,
    ...wasteTableauMoves,
    ...tableauMoves,
    ...foundationTableauMoves,
    ...stockMove
  ];
}

function solverStateKey(state) {
  const foundations = SUITS.map((suit) => state.foundations[suit.id].length).join(',');
  const tableau = state.tableau
    .map((pile) => pile.map((card) => `${card.id}${card.faceUp ? 'u' : 'd'}`).join('.'))
    .join('|');
  const stock = state.stock.map((card) => card.id).join('.');
  const waste = state.waste.map((card) => card.id).join('.');
  return `${foundations};${stock};${waste};${tableau}`;
}

function describeHint(state, move) {
  if (move.kind === 'stock') {
    return state.stock.length > 0 ? 'Draw from the stock.' : 'Recycle the waste back to the stock.';
  }

  const cards = getMovableCards(state, move.source);
  const lead = cards[0];
  if (!lead) return 'Try another legal move.';

  if (move.target.type === 'foundation') {
    return `Move ${cardName(lead)} to the ${suitLabel(move.target.suit)} foundation.`;
  }

  const cardText = cards.length === 1 ? cardName(lead) : `${cardName(lead)} and ${cards.length - 1} more cards`;
  return `Move ${cardText} to tableau column ${move.target.column + 1}.`;
}

function hintMoveKey(move) {
  if (move.kind === 'stock') return 'stock';
  return `${sourceMoveKey(move.source)}>${targetMoveKey(move.target)}`;
}

function sourceMoveKey(source) {
  if (!source) return '';
  if (source.type === 'tableau') return `tableau:${source.column}:${source.index}`;
  if (source.type === 'foundation') return `foundation:${source.suit}`;
  return source.type;
}

function targetMoveKey(target) {
  if (!target) return '';
  if (target.type === 'tableau') return `tableau:${target.column}`;
  if (target.type === 'foundation') return `foundation:${target.suit}`;
  return target.type;
}

function stateFromDeal(dealt, drawMode) {
  return {
    version: STORAGE_VERSION,
    tableau: dealt.tableau.map(cloneCards),
    stock: cloneCards(dealt.stock),
    waste: cloneCards(dealt.waste),
    foundations: cloneFoundations(dealt.foundations),
    initialDeal: clonePiles(dealt),
    drawMode: normalizeDrawMode(drawMode),
    moves: 0,
    elapsedMs: 0,
    timerRunning: false,
    startedAt: null,
    won: false,
    undoStack: [],
    savedAt: 0
  };
}

function removeCards(state, source) {
  if (source.type === 'waste') {
    return state.waste.splice(state.waste.length - 1, 1);
  }

  if (source.type === 'foundation') {
    return state.foundations[source.suit].splice(state.foundations[source.suit].length - 1, 1);
  }

  const pile = state.tableau[source.column];
  const index = source.index ?? pile.length - 1;
  return pile.splice(index);
}

function flipExposedTableauCard(state, source) {
  if (source.type !== 'tableau') return;
  const pile = state.tableau[source.column];
  const exposed = topCard(pile);
  if (exposed && !exposed.faceUp) exposed.faceUp = true;
}

function completeAction(state, moveDelta, now) {
  if (!state.timerRunning && !state.won) {
    state.timerRunning = true;
    state.startedAt = now;
  }
  state.moves += moveDelta;
  state.won = checkWin(state);
  if (state.won) {
    state.elapsedMs = getElapsedMs(state, now);
    state.timerRunning = false;
    state.startedAt = null;
  }
  state.savedAt = now;
}

function createSnapshot(state) {
  return {
    version: STORAGE_VERSION,
    tableau: state.tableau.map(cloneCards),
    stock: cloneCards(state.stock),
    waste: cloneCards(state.waste),
    foundations: cloneFoundations(state.foundations),
    initialDeal: clonePiles(state.initialDeal),
    moves: Number(state.moves) || 0,
    elapsedMs: Number(state.elapsedMs) || 0,
    timerRunning: Boolean(state.timerRunning),
    startedAt: state.startedAt == null ? null : Number(state.startedAt),
    won: Boolean(state.won)
  };
}

function normalizeState(state) {
  if (!state || state.version !== STORAGE_VERSION) return null;
  return {
    version: STORAGE_VERSION,
    tableau: Array.isArray(state.tableau) ? state.tableau.map(cloneCards) : [],
    stock: Array.isArray(state.stock) ? cloneCards(state.stock) : [],
    waste: Array.isArray(state.waste) ? cloneCards(state.waste) : [],
    foundations: cloneFoundations(state.foundations || emptyFoundations()),
    initialDeal: clonePiles(state.initialDeal || {}),
    drawMode: normalizeDrawMode(state.drawMode),
    moves: Number(state.moves) || 0,
    elapsedMs: Number(state.elapsedMs) || 0,
    timerRunning: Boolean(state.timerRunning),
    startedAt: state.startedAt == null ? null : Number(state.startedAt),
    won: Boolean(state.won),
    undoStack: Array.isArray(state.undoStack) ? cloneDeep(state.undoStack) : [],
    savedAt: Number.isFinite(Number(state.savedAt)) ? Number(state.savedAt) : Date.now()
  };
}

function validateState(state) {
  if (!state) return false;
  if (!Array.isArray(state.tableau) || state.tableau.length !== 7) return false;
  if (!state.tableau.every(Array.isArray)) return false;
  if (!Array.isArray(state.stock) || !Array.isArray(state.waste)) return false;
  if (!state.foundations || !SUITS.every((suit) => Array.isArray(state.foundations[suit.id]))) return false;
  if (!state.initialDeal || !Array.isArray(state.initialDeal.tableau) || state.initialDeal.tableau.length !== 7) return false;

  const activeCards = [
    ...state.stock,
    ...state.waste,
    ...state.tableau.flat(),
    ...SUITS.flatMap((suit) => state.foundations[suit.id])
  ];

  if (activeCards.length !== 52) return false;
  const ids = new Set(activeCards.map((card) => card.id));
  return ids.size === 52 && activeCards.every(isValidCard);
}

function isValidCard(card) {
  return (
    card &&
    typeof card.id === 'string' &&
    SUIT_IDS.has(card.suit) &&
    RANK_VALUES.has(card.rank) &&
    typeof card.faceUp === 'boolean'
  );
}

function findNextFoundationMove(state) {
  const candidates = [];
  const waste = topCard(state.waste);
  if (waste) {
    const suit = findFoundationTargetForCard(state, waste);
    if (suit) candidates.push({ source: { type: 'waste' }, target: { type: 'foundation', suit }, card: waste });
  }

  state.tableau.forEach((pile, column) => {
    const card = topCard(pile);
    if (!card?.faceUp) return;
    const suit = findFoundationTargetForCard(state, card);
    if (suit) {
      candidates.push({
        source: { type: 'tableau', column, index: pile.length - 1 },
        target: { type: 'foundation', suit },
        card
      });
    }
  });

  candidates.sort((a, b) => a.card.rank - b.card.rank);
  const best = candidates[0];
  return best ? { source: best.source, target: best.target } : null;
}

function findFoundationTargetForCard(state, card) {
  return SUITS.find((suit) => canPlaceOnFoundation(card, state.foundations[suit.id], suit.id))?.id || null;
}

function getSingleFoundationPlayableCard(state, source) {
  if (source?.type === 'waste') return topCard(state.waste);
  if (source?.type !== 'tableau') return null;
  const pile = state.tableau[source.column];
  if (!pile || source.index !== pile.length - 1) return null;
  const card = topCard(pile);
  return card?.faceUp ? card : null;
}

function isSourceTopCard(state, source) {
  if (source.type === 'waste' || source.type === 'foundation') return true;
  const pile = state.tableau[source.column];
  return Boolean(pile && source.index === pile.length - 1);
}

function tableauReason(cards, destination) {
  if (!destination.length) return 'Only a King or King-led sequence can move to an empty tableau column.';
  return `${cardName(cards[0])} must be placed on the opposite color and one rank higher.`;
}

function topCard(pile) {
  return pile[pile.length - 1] || null;
}

function emptyFoundations() {
  return Object.fromEntries(SUITS.map((suit) => [suit.id, []]));
}

function rankSegment(suit, startRank, endRank) {
  const cards = [];
  for (let rank = endRank; rank >= startRank; rank -= 1) {
    cards.push(makeCard(suit, rank));
  }
  return cards;
}

function makeCard(suit, rank) {
  return {
    id: `${suit}-${rank}`,
    suit,
    rank,
    faceUp: false
  };
}

function clonePiles(piles) {
  return {
    tableau: Array.isArray(piles.tableau) ? piles.tableau.map(cloneCards) : Array.from({ length: 7 }, () => []),
    stock: Array.isArray(piles.stock) ? cloneCards(piles.stock) : [],
    waste: Array.isArray(piles.waste) ? cloneCards(piles.waste) : [],
    foundations: cloneFoundations(piles.foundations || emptyFoundations())
  };
}

function cloneFoundations(foundations) {
  return Object.fromEntries(SUITS.map((suit) => [suit.id, cloneCards(foundations?.[suit.id] || [])]));
}

function cloneCards(cards) {
  return cards.map((card) => ({ ...card }));
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDrawMode(drawMode) {
  return Number(drawMode) === 3 ? 3 : 1;
}

function fail(state, reason) {
  return { ok: false, state, reason };
}
