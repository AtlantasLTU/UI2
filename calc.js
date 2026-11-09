'use strict';

const MAX_DIGITS = 15;
const MAX_UNDO = 100;
const OP_SYMBOLS = { '+': '+', '-': '-', '*': 'x', '/': '÷', '^': '^' };
const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };

const form = document.getElementById('skaiciuotuvas');
const expressionEl = document.getElementById('reiskinys');
const resultEl = document.getElementById('atsakymas');
const messageEl = document.getElementById('pranesimas');
const keypad = form.querySelector('.mygtukai');
const closeParenBtn = form.querySelector('[data-action="close"]');
const historyPanel = document.getElementById('istorija');
const historyList = document.getElementById('istorijosSarasas');
const historyEmpty = document.getElementById('istorijaTuscia');
const historyBtn = form.querySelector('[data-action="history"]');

let tokens = [];
let entry = '0';
let entryLabel = null;
let fresh = true;
let awaitingOperand = false;
let summary = null;
let error = null;
let history = [];
let undoStack = [];

class CalcError extends Error {
    constructor(message, display = 'Klaida') {
        super(message);
        this.display = display;
    }
}

// skaiciavimai

function check(x) {
    if (Number.isNaN(x)) throw new CalcError('Rezultatas neapibrėžtas');
    if (!Number.isFinite(x)) {
        throw new CalcError('Rezultatas per didelis - viršija skaičiuotuvo ribas', x > 0 ? '∞' : '−∞');
    }
    return parseFloat(x.toPrecision(12)); // pašalina 0.1 + 0.2 = 0.30000000000000004 klaidas
}

function binary(op, a, b) {
    switch (op) {
        case '+': return check(a + b);
        case '-': return check(a - b);
        case '*': return check(a * b);
        case '/':
            if (b === 0) {
                if (a === 0) throw new CalcError('0 ÷ 0 - rezultatas neapibrėžtas');
                throw new CalcError('Dalyba iš nulio - rezultatas begalinis', a > 0 ? '∞' : '−∞');
            }
            return check(a / b);
        case '^':
            if (a === 0 && b < 0) throw new CalcError('Nulio kėlimas neigiamu laipsniu - rezultatas begalinis', '∞');
            if (a < 0 && !Number.isInteger(b)) throw new CalcError('Neigiamo skaičiaus negalima kelti trupmeniniu laipsniu');
            return check(a ** b);
    }
}

const wrap = x => (x.startsWith('(') ? x : `(${x})`);

const UNARY = {
    square: {
        label: x => `sqr${wrap(x)}`,
        fn: x => check(x * x),
    },
    sqrt: {
        label: x => `√${wrap(x)}`,
        fn: x => {
            if (x < 0) throw new CalcError('Neigiamo skaičiaus kvadratinė šaknis neegzistuoja');
            return check(Math.sqrt(x));
        },
    },
    inverse: {
        label: x => `1/${wrap(x)}`,
        fn: x => {
            if (x === 0) throw new CalcError('1 ÷ 0 - dalyba iš nulio, rezultatas begalinis', '∞');
            return check(1 / x);
        },
    },
    percent: {
        label: x => `${x}%`,
        fn: x => check(x / 100),
    },
    negate: {
        label: null,
        fn: x => -x,
    },
};

function evaluate(parts) {
    const values = [];
    const ops = [];
    const reduce = () => {
        const b = values.pop();
        const a = values.pop();
        values.push(binary(ops.pop(), a, b));
    };

    for (const part of parts) {
        if (typeof part === 'string') {
            while (ops.length && shouldReduce(ops.at(-1), part)) reduce();
            ops.push(part);
        } else {
            values.push(part.value);
        }
    }
    while (ops.length) reduce();
    return values[0];
}

function shouldReduce(top, next) {
    if (PRECEDENCE[top] > PRECEDENCE[next]) return true;
    return PRECEDENCE[top] === PRECEDENCE[next] && next !== '^';
}

function closeGroup(parts) {
    const start = parts.lastIndexOf('(');
    const inner = parts.slice(start + 1);
    const operand = { value: evaluate(inner), label: `(${expressionText(inner)})` };
    return [...parts.slice(0, start), operand];
}

// formatavimas

function group(str) {
    const [int, dec] = str.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (dec === undefined ? grouped : `${grouped}.${dec}`);
}

function formatNumber(x) {
    if (Object.is(x, -0)) x = 0;
    const abs = Math.abs(x);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) {
        return x.toExponential(6).replace(/\.?0+e/, 'e');
    }
    return group(String(x));
}

function operandText(token, index, parts) {
    const text = token.label ?? formatNumber(token.value);
    const afterOperator = index > 0 && parts[index - 1] !== '(';
    const needsParens = token.label === null && token.value < 0 && (afterOperator || parts[index + 1] === '^');
    return needsParens ? `(${text})` : text;
}

function expressionText(parts) {
    let text = '';
    parts.forEach((part, i) => {
        const piece = typeof part === 'string' ? (OP_SYMBOLS[part] ?? part) : operandText(part, i, parts);
        const tight = i === 0 || parts[i - 1] === '(' || part === ')';
        text += (tight ? '' : ' ') + piece;
    });
    return text;
}

function currentOperand() {
    return { value: Number(entry), label: entryLabel };
}

function openParens(parts) {
    return parts.filter(part => part === '(').length;
}

// ivestis

function reset() {
    tokens = [];
    entry = '0';
    entryLabel = null;
    fresh = true;
    awaitingOperand = false;
    error = null;
}

function showError(e, context) {
    if (!(e instanceof CalcError)) e = new CalcError('Nepavyko apskaičiuoti');
    reset();
    error = { message: e.message, display: e.display };
    summary = context;
}

function startInput() {
    if (error) reset();
    summary = null;
    entryLabel = null;
    awaitingOperand = false;
}

function multiplyAfterGroup() {
    if (!error && !awaitingOperand && entryLabel?.startsWith('(')) {
        tokens.push(currentOperand(), '*');
    }
}

function inputDigit(d) {
    if (!fresh && entry.replace(/[-.]/g, '').length >= MAX_DIGITS) return;
    multiplyAfterGroup();
    const wasFresh = fresh || error;
    startInput();
    if (wasFresh) entry = d;
    else if (entry === '0') entry = d;
    else if (entry === '-0') entry = '-' + d;
    else entry += d;
    fresh = false;
}

function inputDot() {
    multiplyAfterGroup();
    const wasFresh = fresh || error;
    startInput();
    if (wasFresh) entry = '0.';
    else if (!entry.includes('.')) entry += '.';
    fresh = false;
}

function inputOperator(op) {
    if (error) return;
    summary = null;
    if (awaitingOperand && tokens.at(-1) !== '(') {
        tokens[tokens.length - 1] = op;
    } else {
        tokens.push(currentOperand(), op);
    }
    entryLabel = null;
    fresh = true;
    awaitingOperand = true;
}

function openParen() {
    const nothingTyped = !tokens.length && fresh && !entryLabel && entry === '0';
    if (error || summary !== null || nothingTyped) {
        reset();
        summary = null;
        tokens.push('(');
    } else if (awaitingOperand) {
        tokens.push('(');
    } else {
        tokens.push(currentOperand(), '*', '(');
    }
    entry = '0';
    entryLabel = null;
    fresh = true;
    awaitingOperand = true;
}

function closeParen() {
    if (error || !openParens(tokens)) return;
    const parts = [...tokens];
    if (awaitingOperand) {
        if (parts.at(-1) === '(') return;
        parts.pop();
    } else {
        parts.push(currentOperand());
    }

    try {
        const closed = closeGroup(parts);
        const group = closed.pop();
        tokens = closed;
        entry = String(group.value);
        entryLabel = group.label;
        fresh = true;
        awaitingOperand = false;
        summary = null;
    } catch (e) {
        showError(e, expressionText(parts) + ')');
    }
}

function applyUnary(name) {
    if (error) return;
    const op = UNARY[name];

    if (name === 'negate' && !fresh) {
        entry = entry.startsWith('-') ? entry.slice(1) : '-' + entry;
        return;
    }

    const x = Number(entry);
    const label = op.label ? op.label(entryLabel ?? formatNumber(x)) : null;
    try {
        entry = String(op.fn(x));
        entryLabel = label;
        fresh = true;
        awaitingOperand = false;
        summary = null;
    } catch (e) {
        showError(e, label);
    }
}

function calculate() {
    if (error) return;
    let parts = [...tokens];
    if (!awaitingOperand) parts.push(currentOperand());
    while (typeof parts.at(-1) === 'string') parts.pop();
    if (!parts.length || (parts.length === 1 && parts[0].label === null)) return;

    const text = expressionText(parts) + ')'.repeat(openParens(parts)) + ' =';
    try {
        while (openParens(parts)) parts = closeGroup(parts);
        const value = evaluate(parts);
        addHistory(text, value);
        reset();
        entry = String(value);
        summary = text;
    } catch (e) {
        showError(e, text);
    }
}

function clear() {
    reset();
    summary = null;
}

// sugrizimas

function snapshot() {
    return { tokens: [...tokens], entry, entryLabel, fresh, awaitingOperand, summary, error };
}

function perform(action) {
    const before = snapshot();
    action();
    if (JSON.stringify(snapshot()) !== JSON.stringify(before)) {
        undoStack.push(before);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
    }
    render();
}

function undo() {
    const previous = undoStack.pop();
    if (previous) {
        ({ tokens, entry, entryLabel, fresh, awaitingOperand, summary, error } = previous);
    }
    render();
}

// istorija

function addHistory(text, value) {
    history.unshift({ text, value });
    if (history.length > 50) history.pop();
    renderHistory();
}

function renderHistory() {
    historyList.replaceChildren(...history.map((item, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        const expr = document.createElement('span');
        const result = document.createElement('span');
        btn.type = 'button';
        btn.dataset.index = i;
        btn.setAttribute('aria-label', `${item.text} ${formatNumber(item.value)}. Naudoti rezultatą`);
        expr.className = 'ist-reiskinys';
        expr.textContent = item.text;
        result.className = 'ist-rezultatas';
        result.textContent = formatNumber(item.value);
        btn.append(expr, result);
        li.append(btn);
        return li;
    }));
    historyEmpty.hidden = history.length > 0;
}

function toggleHistory(open = historyPanel.hidden) {
    historyPanel.hidden = !open;
    keypad.hidden = open;
    historyBtn.setAttribute('aria-expanded', open);
}

function useHistory(index) {
    if (error) reset();
    entry = String(history[index].value);
    entryLabel = null;
    fresh = true;
    awaitingOperand = false;
    summary = null;
    toggleHistory(false);
}

function clearHistory() {
    history = [];
    renderHistory();
}

// atvaizdavimas

function render() {
    const pending = entryLabel && !awaitingOperand ? [...tokens, currentOperand()] : tokens;
    expressionEl.textContent = summary ?? expressionText(pending);
    messageEl.textContent = error ? error.message : '';

    const shown = error ? error.display : fresh ? formatNumber(Number(entry)) : group(entry);
    resultEl.value = shown;
    resultEl.classList.toggle('ilgas', shown.length > 9);
    resultEl.classList.toggle('labai-ilgas', shown.length > 13);
    resultEl.classList.toggle('klaida', error !== null);

    closeParenBtn.disabled = error !== null || !openParens(tokens);
    keypad.querySelectorAll('[data-op]').forEach(btn => {
        btn.classList.toggle('aktyvus', awaitingOperand && btn.dataset.op === tokens.at(-1));
    });
}

// ivestis su klaviatura + paprasta ivestis mygtukais

const INPUT_ACTIONS = {
    dot: inputDot,
    equals: calculate,
    clear,
    open: openParen,
    close: closeParen,
};

const UI_ACTIONS = {
    undo,
    history: () => toggleHistory(),
    'clear-history': clearHistory,
};

const KEY_ACTIONS = {
    '.': inputDot,
    ',': inputDot,
    '(': openParen,
    ')': closeParen,
    '%': () => applyUnary('percent'),
    '=': calculate,
    Enter: calculate,
    Escape: clear,
    Delete: clear,
};

form.addEventListener('submit', e => e.preventDefault());

form.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const { digit, op, fn, action, index } = btn.dataset;
    if (Object.hasOwn(UI_ACTIONS, action)) return UI_ACTIONS[action]();

    perform(() => {
        if (digit !== undefined) inputDigit(digit);
        else if (op) inputOperator(op);
        else if (fn) applyUnary(fn);
        else if (index !== undefined) useHistory(Number(index));
        else INPUT_ACTIONS[action]?.();
    });
});

document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Backspace') undo();
    else if (/^\d$/.test(k)) perform(() => inputDigit(k));
    else if (Object.hasOwn(PRECEDENCE, k)) perform(() => inputOperator(k));
    else if (Object.hasOwn(KEY_ACTIONS, k)) perform(KEY_ACTIONS[k]);
    else return;
    e.preventDefault();
});

render();
renderHistory();
