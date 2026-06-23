import {
  SUITS,
  cardAriaLabel,
  cardColor,
  cardName,
  canMove,
  createNewGame,
  drawStock,
  getAutoCompletePlan,
  getBestMoveForSource,
  getElapsedMs,
  getHint,
  getMovableCards,
  loadDrawModePreference,
  loadState,
  moveCards,
  rankShort,
  restartSameDeal,
  saveState,
  setDrawMode,
  suitInfo,
  undo
} from './game.js?v=7';

const board = document.querySelector('#board');
const dragLayer = document.querySelector('#drag-layer');
const fireworksCanvas = document.querySelector('#fireworks');
const fireworksCtx = fireworksCanvas?.getContext('2d');
const statusEl = document.querySelector('#status');
const timerEl = document.querySelector('#timer');
const movesEl = document.querySelector('#moves');
const newGameBtn = document.querySelector('#new-game');
const restartBtn = document.querySelector('#restart-game');
const undoBtn = document.querySelector('#undo');
const hintBtn = document.querySelector('#hint');
const drawOneBtn = document.querySelector('#draw-one');
const drawThreeBtn = document.querySelector('#draw-three');
const autoBtn = document.querySelector('#auto-complete');
const MIN_DROP_SLOP = 32;
const MAX_DROP_SLOP = 72;
const AUTO_COMPLETE_CARD_MS = 160;
const AUTO_COMPLETE_CARD_GAP_MS = 35;
const FIREWORK_COLORS = ['#ffdf7a', '#ff6f91', '#67e8f9', '#a7f3d0', '#f9a8d4', '#ffffff'];

let state = loadState(localStorage) || createNewGame({ drawMode: loadDrawModePreference(localStorage) });
let selection = null;
let pendingPointer = null;
let drag = null;
let lastTap = { key: '', at: 0 };
let statusTone = '';
let hintTarget = null;
let isAutoCompleting = false;
let lastKnownWon = Boolean(state.won);
let fireworks = createFireworksState();

saveState(localStorage, state);
render();
updateTimer();
setInterval(updateTimer, 1000);
registerServiceWorker();

newGameBtn.addEventListener('click', () => {
  if (isAutoCompleting) return;
  state = createNewGame({ drawMode: state.drawMode });
  selection = null;
  saveAndRender('New deal started.');
});

restartBtn.addEventListener('click', () => {
  if (isAutoCompleting) return;
  state = restartSameDeal(state);
  selection = null;
  saveAndRender('Restarted the same deal.');
});

undoBtn.addEventListener('click', () => {
  if (isAutoCompleting) return;
  const result = undo(state);
  if (!result.ok) {
    setStatus(result.reason, 'error');
    return;
  }
  state = result.state;
  selection = null;
  saveAndRender('Undid the last action.');
});

hintBtn.addEventListener('click', () => {
  if (isAutoCompleting) return;
  const hint = getHint(state);
  if (!hint.available) {
    selection = null;
    hintTarget = null;
    render();
    setStatus(hint.message, 'error');
    return;
  }

  if (hint.source) {
    const cards = getMovableCards(state, hint.source);
    selection = { source: hint.source, cardIds: cards.map((card) => card.id) };
  } else {
    selection = null;
  }

  hintTarget = hint.target;
  render();
  setStatus(hint.message);
});

drawOneBtn.addEventListener('click', () => updateDrawMode(1));
drawThreeBtn.addEventListener('click', () => updateDrawMode(3));

autoBtn.addEventListener('click', () => {
  runAutoCompleteAnimation();
});

board.addEventListener('pointerdown', handlePointerDown);
board.addEventListener('pointermove', handlePointerMove);
board.addEventListener('pointerup', handlePointerUp);
board.addEventListener('pointercancel', cancelPointer);
document.addEventListener('keydown', handleKeyDown);
window.addEventListener('beforeunload', () => saveState(localStorage, state));

function updateDrawMode(mode) {
  if (isAutoCompleting) return;
  state = setDrawMode(state, mode);
  saveAndRender(`Draw ${mode} mode selected.`);
}

function handlePointerDown(event) {
  if (isAutoCompleting) return;
  if (!event.isPrimary || event.button > 0) return;
  const stock = event.target.closest('[data-pile="stock"]');
  const source = sourceFromElement(event.target);
  const target = targetFromElement(event.target);

  if (!stock && !source && !target) return;

  pendingPointer = {
    pointerId: event.pointerId,
    source,
    target,
    stock: Boolean(stock),
    startX: event.clientX,
    startY: event.clientY,
    element: event.target.closest('[data-card-id]') || event.target
  };

  board.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function handlePointerMove(event) {
  if (!pendingPointer || pendingPointer.pointerId !== event.pointerId || !pendingPointer.source) return;
  const dx = event.clientX - pendingPointer.startX;
  const dy = event.clientY - pendingPointer.startY;

  if (!drag && Math.hypot(dx, dy) > 5) {
    startDrag(event);
  }
  if (drag) {
    moveDrag(event.clientX, event.clientY);
    event.preventDefault();
  }
}

function handlePointerUp(event) {
  if (!pendingPointer || pendingPointer.pointerId !== event.pointerId) return;

  if (drag) {
    finishDrag(event);
  } else if (pendingPointer.stock) {
    handleStockClick();
  } else {
    handleTap(event);
  }

  releasePointer(event.pointerId);
}

function cancelPointer(event) {
  releasePointer(event.pointerId);
  clearDrag();
}

function handleTap(event) {
  const source = pendingPointer.source;
  const target = selection
    ? targetFromPoint(event.clientX, event.clientY, selection.source) || pendingPointer.target
    : targetFromPoint(event.clientX, event.clientY) || pendingPointer.target;

  if (!source && selection && target) {
    attemptMove(selection.source, target);
    return;
  }

  if (!source) {
    if (target && selection) attemptMove(selection.source, target);
    return;
  }

  if (selection && target && !sameSource(selection.source, source)) {
    attemptMove(selection.source, target);
    return;
  }

  const key = sourceKey(source);
  const now = performance.now();
  if (lastTap.key === key && now - lastTap.at < 320) {
    lastTap = { key: '', at: 0 };
    attemptAutoMove(source);
    return;
  }

  lastTap = { key, at: now };
  selectSource(source);
}

function handleKeyDown(event) {
  if (isAutoCompleting) return;
  if (event.key === 'Escape') {
    selection = null;
    hintTarget = null;
    clearDrag();
    render();
    setStatus('Selection cleared.');
    return;
  }

  if (event.key !== 'Enter' && event.key !== ' ') return;
  const active = document.activeElement;
  if (!active || !board.contains(active)) return;
  event.preventDefault();

  if (active.closest('[data-pile="stock"]')) {
    handleStockClick();
    return;
  }

  const source = sourceFromElement(active);
  const target = targetFromElement(active);
  if (source) {
    if (selection && target && !sameSource(selection.source, source)) {
      attemptMove(selection.source, target);
    } else {
      selectSource(source);
    }
  } else if (selection && target) {
    attemptMove(selection.source, target);
  }
}

function handleStockClick() {
  const result = drawStock(state);
  if (!result.ok) {
    setStatus(result.reason, 'error');
    return;
  }
  state = result.state;
  selection = null;
  hintTarget = null;
  saveAndRender(result.action === 'recycle' ? 'Recycled the waste back to stock.' : 'Drew from the stock.');
}

function selectSource(source) {
  const cards = getMovableCards(state, source);
  if (!cards.length) {
    selection = null;
    hintTarget = null;
    render();
    setStatus('That card cannot be moved.', 'error');
    flashTarget(targetForSource(source));
    return;
  }
  selection = { source, cardIds: cards.map((card) => card.id) };
  hintTarget = null;
  render();
  setStatus(cards.length === 1 ? `Selected ${cardName(cards[0])}.` : `Selected a ${cards.length}-card sequence.`);
}

function attemptMove(source, target) {
  const result = moveCards(state, source, target);
  if (!result.ok) {
    selection = null;
    hintTarget = null;
    render();
    setStatus(result.reason, 'error');
    flashTarget(target);
    return;
  }

  state = result.state;
  selection = null;
  hintTarget = null;
  saveAndRender(state.won ? 'You won. Nicely played.' : 'Move completed.', state.won ? 'win' : '');
}

function attemptAutoMove(source) {
  const move = getBestMoveForSource(state, source);
  if (!move) {
    const cards = getMovableCards(state, source);
    selection = null;
    hintTarget = null;
    render();
    setStatus(cards[0] ? `${cardName(cards[0])} has no legal move.` : 'That card cannot be moved.', 'error');
    return;
  }

  const movingCards = getMovableCards(state, source);
  const result = moveCards(state, source, move.target);
  if (!result.ok) {
    selection = null;
    hintTarget = null;
    render();
    setStatus(result.reason, 'error');
    return;
  }
  state = result.state;
  selection = null;
  hintTarget = null;
  const cardText = movingCards.length === 1 ? cardName(movingCards[0]) : `${cardName(movingCards[0])} and ${movingCards.length - 1} more`;
  const destination = move.target.type === 'foundation' ? 'foundation' : `tableau column ${move.target.column + 1}`;
  saveAndRender(state.won ? 'You won. Nicely played.' : `Moved ${cardText} to ${destination}.`, state.won ? 'win' : '');
}

async function runAutoCompleteAnimation() {
  if (isAutoCompleting) return;
  const plan = getAutoCompletePlan(state);
  if (!plan.canComplete) {
    setStatus('Auto-complete is not safe yet.', 'error');
    return;
  }

  isAutoCompleting = true;
  selection = null;
  hintTarget = null;
  render();
  setStatus(`Auto-completing 0 of ${plan.moves.length}.`);

  let movedCards = 0;
  try {
    for (const move of plan.moves) {
      await animateAutoCompleteMove(move);
      const result = moveCards(state, move.source, move.target, {
        recordUndo: movedCards === 0,
        countMove: true
      });

      if (!result.ok) {
        setStatus(result.reason, 'error');
        break;
      }

      state = result.state;
      movedCards += 1;
      saveState(localStorage, state);
      render();
      setStatus(`Auto-completing ${movedCards} of ${plan.moves.length}.`, state.won ? 'win' : '');
      if (movedCards < plan.moves.length) await wait(AUTO_COMPLETE_CARD_GAP_MS);
    }
  } finally {
    clearAutoCompleteFlyers();
    isAutoCompleting = false;
  }

  saveAndRender(
    state.won ? `Auto-completed ${movedCards} cards. You won.` : `Auto-completed ${movedCards} cards.`,
    state.won ? 'win' : ''
  );
}

async function animateAutoCompleteMove(move) {
  if (prefersReducedMotion()) return;
  const cards = getMovableCards(state, move.source);
  const card = cards[0];
  if (!card) return;

  const sourceEl = board.querySelector(`[data-card-id="${card.id}"]`);
  const targetEl = targetElementForMove(move.target);
  if (!sourceEl || !targetEl) return;

  const sourceRect = sourceEl.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const flyer = createAutoCompleteFlyer(card, sourceRect);
  const dx = targetRect.left - sourceRect.left;
  const dy = targetRect.top - sourceRect.top;

  sourceEl.classList.add('is-auto-moving-source');
  try {
    const animation = flyer.animate(
      [
        { transform: 'translate3d(0, 0, 0) scale(1)' },
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.96)` }
      ],
      {
        duration: AUTO_COMPLETE_CARD_MS,
        easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)',
        fill: 'forwards'
      }
    );
    await animation.finished.catch(() => {});
  } finally {
    sourceEl.classList.remove('is-auto-moving-source');
    flyer.remove();
  }
}

function createAutoCompleteFlyer(card, rect) {
  const flyer = document.createElement('div');
  flyer.className = 'auto-complete-flyer';
  flyer.style.left = `${rect.left}px`;
  flyer.style.top = `${rect.top}px`;
  flyer.style.width = `${rect.width}px`;
  flyer.style.height = `${rect.height}px`;
  flyer.innerHTML = cardMarkup(card, { z: 1 });
  dragLayer.append(flyer);
  return flyer;
}

function targetElementForMove(target) {
  if (target.type === 'foundation') {
    return board.querySelector(`[data-target-type="foundation"][data-suit="${target.suit}"]`);
  }
  if (target.type === 'tableau') {
    return board.querySelector(`[data-target-type="tableau"][data-column="${target.column}"]`);
  }
  return null;
}

function clearAutoCompleteFlyers() {
  dragLayer.querySelectorAll('.auto-complete-flyer').forEach((element) => element.remove());
  board.querySelectorAll('.is-auto-moving-source').forEach((element) => element.classList.remove('is-auto-moving-source'));
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function startDrag(event) {
  const cards = getMovableCards(state, pendingPointer.source);
  if (!cards.length) {
    setStatus('That card cannot be moved.', 'error');
    return;
  }

  const rect = pendingPointer.element.getBoundingClientRect();
  drag = {
    source: pendingPointer.source,
    cards,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };

  selection = { source: pendingPointer.source, cardIds: cards.map((card) => card.id) };
  hintTarget = null;
  document.body.classList.add('is-dragging');
  render();
  dragLayer.innerHTML = `<div class="drag-stack">${cards.map((card, index) => cardMarkup(card, { ghost: true, top: index })).join('')}</div>`;
  moveDrag(event.clientX, event.clientY);
}

function moveDrag(clientX, clientY) {
  const stack = dragLayer.querySelector('.drag-stack');
  if (!stack) return;
  stack.style.transform = `translate(${clientX - drag.offsetX}px, ${clientY - drag.offsetY}px)`;
}

function finishDrag(event) {
  const source = drag.source;
  const target = targetFromDrop(event.clientX, event.clientY, source);
  clearDrag();
  if (!target) {
    selection = null;
    hintTarget = null;
    render();
    setStatus('Choose a tableau column or foundation.', 'error');
    return;
  }
  attemptMove(source, target);
}

function clearDrag() {
  drag = null;
  dragLayer.innerHTML = '';
  document.body.classList.remove('is-dragging');
}

function releasePointer(pointerId) {
  if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
  pendingPointer = null;
}

function saveAndRender(message, tone = '') {
  hintTarget = null;
  saveState(localStorage, state);
  render();
  const autoReady = getAutoCompletePlan(state).canComplete;
  const text = message
    ? `${message}${autoReady && !state.won ? ' Auto-complete is available.' : ''}`
    : autoReady
      ? 'Auto-complete is available.'
      : 'Ready.';
  setStatus(text, tone || (autoReady ? 'win' : ''));
  syncWinCelebration();
}

function render() {
  movesEl.textContent = `${state.moves} ${state.moves === 1 ? 'move' : 'moves'}`;
  newGameBtn.disabled = isAutoCompleting;
  restartBtn.disabled = isAutoCompleting;
  undoBtn.disabled = isAutoCompleting || state.undoStack.length === 0;
  hintBtn.disabled = isAutoCompleting || state.won;
  drawOneBtn.disabled = isAutoCompleting;
  drawThreeBtn.disabled = isAutoCompleting;
  drawOneBtn.setAttribute('aria-pressed', String(state.drawMode === 1));
  drawThreeBtn.setAttribute('aria-pressed', String(state.drawMode === 3));

  const autoPlan = getAutoCompletePlan(state);
  autoBtn.disabled = isAutoCompleting || !autoPlan.canComplete;
  autoBtn.title = autoPlan.canComplete ? 'Finish the safe foundation moves' : 'Available when no guessing remains';

  board.innerHTML = `
    ${state.won ? '<div class="win-banner">You won</div>' : ''}
    <div class="top-row">
      ${stockMarkup()}
      ${wasteMarkup()}
      <div class="foundations" aria-label="Foundations">
        ${SUITS.map((suit) => foundationMarkup(suit)).join('')}
      </div>
    </div>
    <div class="tableau" aria-label="Tableau">
      ${state.tableau.map((pile, index) => tableauMarkup(pile, index)).join('')}
    </div>
  `;

  updateTimer();
}

function stockMarkup() {
  const label = state.stock.length
    ? `Stock, ${state.stock.length} face-down ${state.stock.length === 1 ? 'card' : 'cards'}`
    : state.waste.length
      ? 'Empty stock, recycle waste'
      : 'Empty stock';
  return `
    <div class="pile stock${isHintTarget({ type: 'stock' }) ? ' is-hint-target' : ''}" data-pile="stock" role="button" tabindex="0" aria-label="${escapeHtml(label)}">
      ${
        state.stock.length
          ? '<div class="card face-down" role="img" aria-label="Face-down stock card"></div>'
          : '<div class="empty-pile">Stock</div>'
      }
    </div>
  `;
}

function wasteMarkup() {
  const visible = state.waste.slice(-3);
  const label = state.waste.length ? `Waste, ${state.waste.length} cards` : 'Waste, empty';
  return `
    <div class="pile waste" aria-label="${escapeHtml(label)}">
      ${state.waste.length ? '' : '<div class="empty-pile">Waste</div>'}
      ${visible
        .map((card, index) => {
          const isTop = index === visible.length - 1;
          return cardMarkup(card, {
            source: isTop ? { type: 'waste' } : null,
            left: index,
            z: index + 1
          });
        })
        .join('')}
    </div>
  `;
}

function foundationMarkup(suit) {
  const pile = state.foundations[suit.id];
  const top = pile[pile.length - 1];
  const label = `Foundation ${suit.label}, ${pile.length} cards`;
  return `
    <div class="pile foundation${isHintTarget({ type: 'foundation', suit: suit.id }) ? ' is-hint-target' : ''}" data-target-type="foundation" data-suit="${suit.id}" role="button" tabindex="0" aria-label="${escapeHtml(label)}">
      ${top ? cardMarkup(top, { source: { type: 'foundation', suit: suit.id }, z: 1 }) : emptyFoundationMarkup(suit)}
    </div>
  `;
}

function emptyFoundationMarkup(suit) {
  return `
    <div class="empty-pile">
      <span class="foundation-mark">${suit.symbol}</span>
      <span class="foundation-label">${suit.label}</span>
    </div>
  `;
}

function tableauMarkup(pile, column) {
  const label = `Tableau column ${column + 1}, ${pile.length} ${pile.length === 1 ? 'card' : 'cards'}`;
  const height = `calc(var(--card-h) + ${Math.max(0, pile.length - 1)} * var(--stack-gap))`;
  return `
    <div class="pile tableau-column${isHintTarget({ type: 'tableau', column }) ? ' is-hint-target' : ''}" data-target-type="tableau" data-column="${column}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" style="height: ${height}">
      ${pile.length ? '' : '<div class="empty-pile">Tableau</div>'}
      ${pile.map((card, index) => cardMarkup(card, { source: card.faceUp ? { type: 'tableau', column, index } : null, top: index, z: index + 1 })).join('')}
    </div>
  `;
}

function cardMarkup(card, options = {}) {
  const suit = suitInfo(card.suit);
  const selected = selection?.cardIds.includes(card.id);
  const sourceAttrs = options.source ? sourceAttrsMarkup(options.source) : '';
  const role = options.source ? 'button' : 'img';
  const tabindex = options.source ? '0' : '-1';
  const top = options.top == null ? '' : `top: calc(${options.top} * var(--stack-gap));`;
  const left = options.left == null ? '' : `left: calc(${options.left} * var(--waste-gap));`;
  const z = options.z == null ? '' : `z-index: ${options.z};`;
  const ghostTop = options.ghost ? `top: calc(${options.top} * var(--stack-gap));` : '';
  const dragClass = selected && drag ? ' is-drag-source' : '';

  if (!card.faceUp) {
    return `<div class="card face-down${dragClass}" role="img" aria-label="Face-down card" style="${top}${left}${z}${ghostTop}"></div>`;
  }

  return `
    <div class="card face-up ${cardColor(card)}${selected ? ' is-selected' : ''}${dragClass}" role="${role}" tabindex="${tabindex}" aria-label="${escapeHtml(cardAriaLabel(card))}" data-card-id="${card.id}" ${sourceAttrs} style="${top}${left}${z}${ghostTop}">
      <div class="card-inner">
        <div class="rank"><span>${rankShort(card.rank)}</span><span class="pip">${suit.symbol}</span></div>
        <div class="center-suit">${suit.symbol}</div>
      </div>
    </div>
  `;
}

function sourceAttrsMarkup(source) {
  const attrs = [`data-source-type="${source.type}"`];
  if (source.column != null) attrs.push(`data-column="${source.column}"`);
  if (source.index != null) attrs.push(`data-index="${source.index}"`);
  if (source.suit) attrs.push(`data-suit="${source.suit}"`);
  return attrs.join(' ');
}

function sourceFromElement(element) {
  const sourceEl = element.closest('[data-source-type]');
  if (!sourceEl) return null;
  const type = sourceEl.dataset.sourceType;
  if (type === 'waste') return { type };
  if (type === 'foundation') return { type, suit: sourceEl.dataset.suit };
  if (type === 'tableau') {
    return {
      type,
      column: Number(sourceEl.dataset.column),
      index: Number(sourceEl.dataset.index)
    };
  }
  return null;
}

function targetFromElement(element) {
  const targetEl = element.closest('[data-target-type]');
  if (!targetEl) return null;
  if (targetEl.dataset.targetType === 'foundation') {
    return { type: 'foundation', suit: targetEl.dataset.suit };
  }
  if (targetEl.dataset.targetType === 'tableau') {
    return { type: 'tableau', column: Number(targetEl.dataset.column) };
  }
  return null;
}

function targetFromPoint(clientX, clientY, source = null) {
  const stack = dragLayer.querySelector('.drag-stack');
  if (stack) stack.style.display = 'none';
  const element = document.elementFromPoint(clientX, clientY);
  const exactTarget = element ? targetFromElement(element) : null;
  const target = source ? nearbyLegalTarget(clientX, clientY, source, exactTarget) || exactTarget : exactTarget;
  if (stack) stack.style.display = '';
  return target;
}

function targetFromDrop(clientX, clientY, source) {
  const stack = dragLayer.querySelector('.drag-stack');
  const rect = stack?.getBoundingClientRect();
  const points = [{ x: clientX, y: clientY }];

  if (rect) {
    points.push(
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height, cardHeight() / 2) }
    );
  }

  for (const point of points) {
    const target = targetFromPoint(point.x, point.y, source);
    if (target && canMove(state, source, target).ok) return target;
  }

  return targetFromPoint(clientX, clientY);
}

function nearbyLegalTarget(clientX, clientY, source, exactTarget) {
  if (exactTarget && canMove(state, source, exactTarget).ok) return exactTarget;

  const tolerance = dropSlop();
  const targets = [...board.querySelectorAll('[data-target-type]')]
    .map((element) => ({ element, target: targetFromElement(element) }))
    .filter(({ target }) => target && canMove(state, source, target).ok)
    .map(({ element, target }) => ({
      target,
      distance: distanceToRect(clientX, clientY, element.getBoundingClientRect())
    }))
    .filter(({ distance }) => distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);

  return targets[0]?.target || null;
}

function dropSlop() {
  return Math.min(MAX_DROP_SLOP, Math.max(MIN_DROP_SLOP, cardWidth() * 0.72));
}

function cardWidth() {
  return board.querySelector('.pile')?.getBoundingClientRect().width || MIN_DROP_SLOP;
}

function cardHeight() {
  return board.querySelector('.pile')?.getBoundingClientRect().height || MIN_DROP_SLOP * 1.42;
}

function distanceToRect(x, y, rect) {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function targetForSource(source) {
  if (!source) return null;
  if (source.type === 'foundation') return { type: 'foundation', suit: source.suit };
  if (source.type === 'tableau') return { type: 'tableau', column: source.column };
  return null;
}

function flashTarget(target) {
  if (!target) return;
  const selector =
    target.type === 'foundation'
      ? `[data-target-type="foundation"][data-suit="${target.suit}"]`
      : `[data-target-type="tableau"][data-column="${target.column}"]`;
  const el = board.querySelector(selector);
  if (!el) return;
  el.classList.add('is-invalid');
  setTimeout(() => el.classList.remove('is-invalid'), 260);
}

function sameSource(a, b) {
  return sourceKey(a) === sourceKey(b);
}

function isHintTarget(target) {
  if (!hintTarget || !target || hintTarget.type !== target.type) return false;
  if (target.type === 'foundation') return hintTarget.suit === target.suit;
  if (target.type === 'tableau') return hintTarget.column === target.column;
  return target.type === 'stock';
}

function sourceKey(source) {
  if (!source) return '';
  if (source.type === 'tableau') return `tableau:${source.column}:${source.index}`;
  if (source.type === 'foundation') return `foundation:${source.suit}`;
  return source.type;
}

function updateTimer() {
  timerEl.textContent = formatTime(getElapsedMs(state));
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function setStatus(message, tone = '') {
  statusTone = tone;
  statusEl.textContent = message;
  statusEl.className = `status${statusTone ? ` is-${statusTone}` : ''}`;
}

function syncWinCelebration() {
  if (state.won && !lastKnownWon) {
    startFireworks();
  } else if (!state.won) {
    stopFireworks();
  }
  lastKnownWon = Boolean(state.won);
}

function createFireworksState() {
  return {
    active: false,
    rockets: [],
    particles: [],
    rafId: 0,
    launchInterval: 0,
    lastFrame: 0
  };
}

function startFireworks() {
  if (!fireworksCanvas || !fireworksCtx || prefersReducedMotion()) return;
  stopFireworks();

  fireworks = createFireworksState();
  fireworks.active = true;
  fireworks.lastFrame = performance.now();
  fireworksCanvas.hidden = false;
  document.body.classList.add('is-celebrating');
  resizeFireworksCanvas();

  launchFirework();
  fireworks.launchInterval = window.setInterval(launchFirework, 320);
  armFireworksDismissal();
  fireworks.rafId = requestAnimationFrame(updateFireworks);
}

function stopFireworks() {
  if (!fireworks.active) return;
  if (fireworks.launchInterval) clearInterval(fireworks.launchInterval);
  if (fireworks.rafId) cancelAnimationFrame(fireworks.rafId);
  disarmFireworksDismissal();
  fireworks = createFireworksState();
  clearFireworksCanvas();
  if (fireworksCanvas) fireworksCanvas.hidden = true;
  document.body.classList.remove('is-celebrating');
}

function armFireworksDismissal() {
  window.addEventListener('pointerdown', dismissFireworksFromUser, true);
  window.addEventListener('mousemove', dismissFireworksFromUser, true);
}

function disarmFireworksDismissal() {
  window.removeEventListener('pointerdown', dismissFireworksFromUser, true);
  window.removeEventListener('mousemove', dismissFireworksFromUser, true);
}

function dismissFireworksFromUser() {
  stopFireworks();
}

function launchFirework() {
  if (!fireworks.active || !fireworksCanvas) return;
  const width = fireworksCanvas.width / canvasScale();
  const height = fireworksCanvas.height / canvasScale();
  const startX = width * (0.18 + Math.random() * 0.64);
  const startY = height + 12;
  const targetX = width * (0.16 + Math.random() * 0.68);
  const targetY = height * (0.14 + Math.random() * 0.34);
  const duration = 620 + Math.random() * 260;

  fireworks.rockets.push({
    x: startX,
    y: startY,
    startX,
    startY,
    targetX,
    targetY,
    elapsed: 0,
    duration,
    color: randomFireworkColor(),
    trail: []
  });
}

function updateFireworks(now) {
  if (!fireworks.active || !fireworksCtx || !fireworksCanvas) return;

  const dt = Math.min(40, now - fireworks.lastFrame);
  fireworks.lastFrame = now;
  fireworksCtx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
  updateRockets(dt);
  updateParticles(dt);
  drawRockets();
  drawParticles();

  if (fireworks.active) {
    fireworks.rafId = requestAnimationFrame(updateFireworks);
  }
}

function updateRockets(dt) {
  for (let index = fireworks.rockets.length - 1; index >= 0; index -= 1) {
    const rocket = fireworks.rockets[index];
    rocket.elapsed += dt;
    const progress = Math.min(1, rocket.elapsed / rocket.duration);
    const eased = 1 - (1 - progress) ** 3;
    const wobble = Math.sin(progress * Math.PI * 5) * 8 * (1 - progress);

    rocket.x = rocket.startX + (rocket.targetX - rocket.startX) * eased + wobble;
    rocket.y = rocket.startY + (rocket.targetY - rocket.startY) * eased;
    rocket.trail.push({ x: rocket.x, y: rocket.y });
    if (rocket.trail.length > 8) rocket.trail.shift();

    if (progress >= 1) {
      burstFirework(rocket);
      fireworks.rockets.splice(index, 1);
    }
  }
}

function updateParticles(dt) {
  for (let index = fireworks.particles.length - 1; index >= 0; index -= 1) {
    const particle = fireworks.particles[index];
    particle.elapsed += dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vy += 0.00022 * dt;
    particle.vx *= 0.995;

    if (particle.elapsed >= particle.life) {
      fireworks.particles.splice(index, 1);
    }
  }
}

function burstFirework(rocket) {
  const count = 44 + Math.floor(Math.random() * 18);
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.16;
    const speed = 0.055 + Math.random() * 0.18;
    fireworks.particles.push({
      x: rocket.x,
      y: rocket.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 1.4 + Math.random() * 1.7,
      color: Math.random() < 0.75 ? rocket.color : randomFireworkColor(),
      elapsed: 0,
      life: 760 + Math.random() * 520
    });
  }
}

function drawRockets() {
  for (const rocket of fireworks.rockets) {
    fireworksCtx.save();
    fireworksCtx.strokeStyle = rocket.color;
    fireworksCtx.lineWidth = 2;
    fireworksCtx.lineCap = 'round';
    fireworksCtx.shadowBlur = 12;
    fireworksCtx.shadowColor = rocket.color;
    fireworksCtx.beginPath();
    rocket.trail.forEach((point, index) => {
      if (index === 0) fireworksCtx.moveTo(point.x, point.y);
      else fireworksCtx.lineTo(point.x, point.y);
    });
    fireworksCtx.stroke();
    fireworksCtx.restore();
  }
}

function drawParticles() {
  for (const particle of fireworks.particles) {
    const remaining = 1 - particle.elapsed / particle.life;
    fireworksCtx.save();
    fireworksCtx.globalAlpha = Math.max(0, remaining);
    fireworksCtx.fillStyle = particle.color;
    fireworksCtx.shadowBlur = 14;
    fireworksCtx.shadowColor = particle.color;
    fireworksCtx.beginPath();
    fireworksCtx.arc(particle.x, particle.y, particle.radius * remaining, 0, Math.PI * 2);
    fireworksCtx.fill();
    fireworksCtx.restore();
  }
}

function resizeFireworksCanvas() {
  if (!fireworksCanvas || !fireworksCtx) return;
  const scale = canvasScale();
  fireworksCanvas.width = Math.floor(window.innerWidth * scale);
  fireworksCanvas.height = Math.floor(window.innerHeight * scale);
  fireworksCtx.setTransform(scale, 0, 0, scale, 0, 0);
}

function clearFireworksCanvas() {
  if (!fireworksCanvas || !fireworksCtx) return;
  fireworksCtx.clearRect(0, 0, fireworksCanvas.width, fireworksCanvas.height);
}

function canvasScale() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function randomFireworkColor() {
  return FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]
  ));
}

window.addEventListener('resize', () => {
  if (fireworks.active) resizeFireworksCanvas();
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
