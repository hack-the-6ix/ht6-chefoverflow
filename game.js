// =============================================
// AUTONOMOUS KITCHEN ARENA - Full Game
// =============================================

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// Grid configuration - BIGGER
const CELL_SIZE = 48;
const MAP_WIDTH = 20;
const MAP_HEIGHT = 14;

canvas.width = MAP_WIDTH * CELL_SIZE;
canvas.height = MAP_HEIGHT * CELL_SIZE;

const floorImg = new Image();
floorImg.src = 'assets/floor.png';

// =============================================
// GAME STATE
// =============================================
const GameState = {
    running: false,
    paused: false,
    time: 0,
    score: 0,
    difficulty: 1.0,
    streak: 0,
    bestStreak: 0,
    selectedChef: null,
    failedOrders: 0,
    maxFailedOrders: 3,
    moveTimer: 0,
    moveDelay: 0.18, // Slower chef movement
    rush: {
        active: false,
        timeLeft: 0,
        cooldown: 20
    },
    /** Frametime accumulator for steadier order spawn rate than pure Poisson */
    orderSpawnDebt: 0,
    ordersDelivered: 0,
    phaseBanner60: false,
    phaseBanner150: false,
    phaseBanner600Float: false,
    gameOver: false
};

// =============================================
// EVENT BUS (KitchenAPI agent hooks)
// =============================================
const EventBus = {
    _listeners: {},
    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return () => {
            this._listeners[event] = (this._listeners[event] || []).filter(cb => cb !== callback);
        };
    },
    emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error(`KitchenAPI event error (${event}):`, e);
                }
            });
        }
    },
    clear() {
        this._listeners = {};
    }
};

// Single persistent agent slot. Survives start()/restart and replaces any
// prior agent, so re-pasting a script never double-registers.
let _agentFn = null;
let _agentOff = null;
function registerAgent() {
    if (_agentOff) { _agentOff(); _agentOff = null; }
    if (typeof _agentFn === 'function') {
        _agentOff = EventBus.on('tick', (data) => {
            try { _agentFn(window.KitchenAPI.getState(), window.KitchenAPI, data); }
            catch (e) { console.error('Agent error:', e); }
        });
    }
}

let lastEmittedPhase = 'tutorial';

function getPhaseKey(time) {
    if (time < 60) return 'tutorial';
    if (time < 150) return 'ramp';
    if (time < 600) return 'automation';
    return 'endurance';
}

function getApiPhase(time) {
    return getPhaseKey(time);
}

/** Rush + spawn pressure use the same rules for automation and endurance */
function isHighPressurePhase(phase) {
    return phase === 'automation' || phase === 'endurance';
}

function smoothstep01(x, edge0, edge1) {
    if (x <= edge0) return 0;
    if (x >= edge1) return 1;
    const t = (x - edge0) / (edge1 - edge0);
    return t * t * (3 - 2 * t);
}

function getPerformanceAdjustment() {
    const delivered = GameState.ordersDelivered;
    const failed = GameState.failedOrders;
    const successRate = delivered + failed > 0 ? delivered / (delivered + failed) : 0.6;
    const streakBonus = Math.min(0.2, GameState.streak * 0.01);
    const failPenalty = Math.min(0.18, failed * 0.05);
    return Math.max(-0.2, Math.min(0.3, (successRate - 0.55) * 0.28 + streakBonus - failPenalty));
}

/**
 * Graduated recipe pool so automation does not dump all expert dishes at 2:30.
 * endurance → null = full RECIPES table.
 */
function getRecipeNamesForSpawn(time) {
    const phase = getPhaseKey(time);
    if (phase === 'tutorial') return RECIPE_NAMES_BY_PHASE.tutorial;
    if (phase === 'ramp') return RECIPE_NAMES_BY_PHASE.ramp;
    if (phase === 'endurance') return null;

    const rel = time - 150;
    const pool = ['Salad', 'Steak', 'Burger'];
    if (rel >= 35) pool.push('Pizza');
    if (rel >= 95) pool.push('Deluxe Burger');
    if (rel >= 170) pool.push('Feast Platter');
    if (rel >= 255) pool.push('Supreme Pizza');
    return pool;
}

/** Seconds between orders on average (before debt resolution); rush tightens further */
function baseOrderSpawnInterval(time, rushActive) {
    let normal;
    if (time < 60) {
        normal = 20 - smoothstep01(time, 0, 55) * 8;       // 20→12s
    } else if (time < 150) {
        normal = 12 - smoothstep01(time, 60, 145) * 4;     // 12→8s
    } else if (time < 600) {
        normal = 8 - smoothstep01(time, 150, 580) * 4;     // 8→4s
    } else {
        normal = Math.max(2.5, 4 - (time - 600) * 0.003);  // 4→2.5s over ~500s
    }
    if (rushActive) normal *= 0.52;
    const perf = getPerformanceAdjustment();
    return Math.max(2.5, normal * (1 - perf * 0.35));
}

function orderTimeLimitForSpawn(time) {
    const phase = getPhaseKey(time);
    if (phase === 'tutorial') {
        return 52 + Math.floor(Math.random() * 6);          // 52–58s
    }
    if (phase === 'ramp') {
        return 40 + Math.floor(Math.random() * 6);          // 40–46s
    }
    let sec;
    if (phase === 'endurance') {
        sec = Math.max(14, 22 - (time - 600) * 0.012);     // 22→14s over ~667s
    } else {
        const u = smoothstep01(time, 150, 520);
        sec = Math.round(38 - u * 16);                      // 38→22s
    }
    sec = Math.max(14, sec);
    const perf = getPerformanceAdjustment();
    sec = Math.round(sec * (1 - perf * 0.22));
    return sec + Math.floor(Math.random() * 5);
}

function computeDifficulty(time) {
    const phase = getPhaseKey(time);
    let base;
    if (phase === 'tutorial') {
        base = 1.0 + smoothstep01(time, 0, 58) * 0.1;      // 1.0→1.1
    } else if (phase === 'ramp') {
        base = 1.1 + smoothstep01(time, 60, 148) * 0.5;    // 1.1→1.6
    } else if (phase === 'automation') {
        base = 1.6 + smoothstep01(time, 150, 595) * 1.6;   // 1.6→3.2
    } else {
        base = 3.2 + (time - 600) * 0.006;                  // +0.006/s, hits 5.0 at ~t=937
    }
    return Math.max(1.0, base * (1 + getPerformanceAdjustment()));
}

// =============================================
// COLORS
// =============================================
const COLORS = {
    floor: '#1e2a38',
    floorTile: '#1c2836',
    wall: '#4a4a6a',
    counter: '#6a6a8a',
    
    // Stations
    ingredientBin: '#5d4037',
    stove: '#bf360c',
    stoveOn: '#ff6f00',
    cuttingBoard: '#8d6e63',
    platingArea: '#1565c0',
    receptionStand: '#6a1b9a',
    
    // Chefs
    chef: ['#e53935', '#43a047', '#1e88e5', '#fb8c00', '#8e24aa'],
    chefSelected: '#ffffff',
    
    // Ingredients
    tomato: '#e53935',
    lettuce: '#66bb6a',
    onion: '#ce93d8',
    meat: '#5d4037',
    dough: '#d7ccc8',
    cheese: '#ffc107',
    
    // States
    raw: '#666',
    chopped: '#888',
    cooked: '#aa8855',
    burnt: '#222'
};

const INGREDIENT_ICONS = {
    tomato: 'TM',
    lettuce: 'LT',
    onion: 'ON',
    meat: 'MT',
    dough: 'DG',
    cheese: 'CH'
};

const RECIPE_ICON_BY_NAME = {
    Salad: 'SAL',
    Burger: 'BRG',
    Steak: 'STK',
    Pizza: 'PZZ',
    'Deluxe Burger': 'DBR',
    'Feast Platter': 'FST',
    'Supreme Pizza': 'SPZ'
};

const SKIN_SOURCES = {
    ingredient: {
        tomato: 'assets/skins/ingredients/tomato.png',
        lettuce: 'assets/skins/ingredients/lettuce.png',
        onion: 'assets/skins/ingredients/onion.png',
        meat: 'assets/skins/ingredients/meat.png',
        dough: 'assets/skins/ingredients/dough.png',
        cheese: 'assets/skins/ingredients/cheese.png'
    },
    chef: ['assets/skins/chefs/chef-1.png', 'assets/skins/chefs/chef-2.png', 'assets/skins/chefs/chef-3.png', 'assets/skins/chefs/chef-4.png', 'assets/skins/chefs/chef-5.png'],
    station: {
        stove: 'assets/skins/stations/stove.png',
        cuttingBoard: 'assets/skins/stations/cutting-board.png',
        platingArea: 'assets/skins/stations/plating-area.png',
        trash: 'assets/skins/stations/trash.png',
        receptionStand: 'assets/skins/stations/reception-stand.png',
        counter: 'assets/skins/stations/counter.png',
        ingredientBin: 'assets/skins/stations/ingredient-bin.png'
    },
    order: {
        Salad: 'assets/skins/orders/salad.png',
        Burger: 'assets/skins/orders/burger.png',
        Steak: 'assets/skins/orders/steak.png',
        Pizza: 'assets/skins/orders/pizza.png',
        'Deluxe Burger': 'assets/skins/orders/deluxe-burger.png',
        'Feast Platter': 'assets/skins/orders/feast-platter.png',
        'Supreme Pizza': 'assets/skins/orders/supreme-pizza.png'
    }
};

const SkinStore = (() => {
    const images = new Map();
    function load(path) {
        const img = new Image();
        img.src = path;
        images.set(path, { img, loaded: false });
        img.onload = () => {
            const e = images.get(path);
            if (e) e.loaded = true;
        };
        img.onerror = () => images.delete(path);
    }
    function flattenPaths() {
        const all = [];
        Object.values(SKIN_SOURCES.ingredient).forEach(p => all.push(p));
        SKIN_SOURCES.chef.forEach(p => all.push(p));
        Object.values(SKIN_SOURCES.station).forEach(p => all.push(p));
        Object.values(SKIN_SOURCES.order).forEach(p => all.push(p));
        return all;
    }
    function init() {
        flattenPaths().forEach(load);
    }
    function draw(path, x, y, w, h, fit) {
        const entry = images.get(path);
        if (!entry || !entry.loaded) return false;
        const img = entry.img;
        if (fit === 'contain' && img.naturalWidth && img.naturalHeight) {
            // preserve source aspect ratio, anchored bottom-center
            const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
            const dw = img.naturalWidth * scale;
            const dh = img.naturalHeight * scale;
            ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh), dw, dh);
        } else {
            ctx.drawImage(img, x, y, w, h);
        }
        return true;
    }
    return { init, draw };
})();

const ScoreGuard = (() => {
    const secret = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    let authoritativeScore = 0;
    let eventChain = 2166136261;
    let events = 0;
    function hashStep(str) {
        let h = eventChain;
        const source = str + '|' + secret;
        for (let i = 0; i < source.length; i++) {
            h ^= source.charCodeAt(i);
            h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
        }
        eventChain = h >>> 0;
        return eventChain;
    }
    function reset() {
        authoritativeScore = 0;
        eventChain = 2166136261;
        events = 0;
        hashStep('reset');
    }
    function applyDelta(delta, reason) {
        authoritativeScore += delta;
        events++;
        hashStep(`${reason}|${Math.round(delta)}|${Math.round(authoritativeScore)}`);
        GameState.score = authoritativeScore;
    }
    function tick(time) {
        hashStep(`tick|${Math.floor(time)}|${Math.floor(authoritativeScore)}|${GameState.ordersDelivered}|${GameState.failedOrders}`);
    }
    function verifyFinal() {
        return GameState.score === authoritativeScore && events > 0;
    }
    function receipt() {
        return `${eventChain.toString(16)}-${events.toString(36)}`;
    }
    return { reset, applyDelta, tick, verifyFinal, receipt };
})();

const FLOOR_PX = 8; // chunky pixel size for the pixel-art floor texture

function floorBaseColor(x, y) {
    const light = (x + y) % 2 === 0;
    if (x >= 14) {
        return light ? [29, 20, 85] : [24, 15, 72];
    }
    return light ? [26, 18, 80] : [21, 14, 66];
}

function tileHash(x, y, salt) {
    let h = (x * 374761393 + y * 668265263 + (salt | 0) * 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return h ^ (h >>> 16);
}

function shadeRGB(rgb, amt) {
    const r = Math.max(0, Math.min(255, rgb[0] + amt));
    const g = Math.max(0, Math.min(255, rgb[1] + amt));
    const b = Math.max(0, Math.min(255, rgb[2] + amt));
    return `rgb(${r},${g},${b})`;
}

let floorTextureCanvas = null;

function drawPixelSparkle(fc, ox, oy, h) {
    const s = FLOOR_PX;
    const gx = 1 + (h % 4);
    const gy = 1 + ((h >> 4) % 4);
    const px = ox + gx * s;
    const py = oy + gy * s;
    // dim gold arms
    fc.fillStyle = 'rgba(232,184,75,0.20)';
    fc.fillRect(px - s, py, s, s);
    fc.fillRect(px + s, py, s, s);
    fc.fillRect(px, py - s, s, s);
    fc.fillRect(px, py + s, s, s);
    // bright gold core
    fc.fillStyle = 'rgba(255,214,110,0.62)';
    fc.fillRect(px, py, s, s);
}

const WALL_BASE = [92, 84, 134];    // lavender-purple raised border
const COUNTER_BASE = [122, 116, 152]; // lighter polished work surface / divider

function paintPixelTile(fc, tx, ty, base, bevel, darkAmt, lightAmt, darkPct, lightPct) {
    const PX = FLOOR_PX;
    const SUB = CELL_SIZE / PX;
    const edge = PX / 2;
    const ox = tx * CELL_SIZE;
    const oy = ty * CELL_SIZE;

    fc.fillStyle = shadeRGB(base, 0);
    fc.fillRect(ox, oy, CELL_SIZE, CELL_SIZE);

    // chunky dither speckles, deterministic per sub-cell
    for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
            const n = tileHash(tx * 17 + sx, ty * 17 + sy, 7) % 100;
            if (n < darkPct) {
                fc.fillStyle = shadeRGB(base, darkAmt);
                fc.fillRect(ox + sx * PX, oy + sy * PX, PX, PX);
            } else if (n < darkPct + lightPct) {
                fc.fillStyle = shadeRGB(base, lightAmt);
                fc.fillRect(ox + sx * PX, oy + sy * PX, PX, PX);
            }
        }
    }

    // beveled pixel edges, lit top/left, shadowed bottom/right
    fc.fillStyle = shadeRGB(base, bevel);
    fc.fillRect(ox, oy, CELL_SIZE, edge);
    fc.fillRect(ox, oy, edge, CELL_SIZE);
    fc.fillStyle = shadeRGB(base, -bevel);
    fc.fillRect(ox, oy + CELL_SIZE - edge, CELL_SIZE, edge);
    fc.fillRect(ox + CELL_SIZE - edge, oy, edge, CELL_SIZE);
}

function paintCounterTile(fc, tx, ty) {
    // polished pixel countertop: gentle dither, soft bevel, inset panel groove
    paintPixelTile(fc, tx, ty, COUNTER_BASE, 26, -15, 19, 8, 11);
    const ox = tx * CELL_SIZE;
    const oy = ty * CELL_SIZE;
    const inset = FLOOR_PX;
    // inset panel groove, darker recessed frame
    fc.fillStyle = shadeRGB(COUNTER_BASE, -30);
    fc.fillRect(ox + inset, oy + inset, CELL_SIZE - inset * 2, 2);
    fc.fillRect(ox + inset, oy + CELL_SIZE - inset - 2, CELL_SIZE - inset * 2, 2);
    fc.fillRect(ox + inset, oy + inset, 2, CELL_SIZE - inset * 2);
    fc.fillRect(ox + CELL_SIZE - inset - 2, oy + inset, 2, CELL_SIZE - inset * 2);
    // polished sheen along the top
    fc.fillStyle = 'rgba(255,255,255,0.14)';
    fc.fillRect(ox + FLOOR_PX / 2, oy + FLOOR_PX / 2, CELL_SIZE - FLOOR_PX, 2);
}

function buildFloorTexture() {
    floorTextureCanvas = document.createElement('canvas');
    floorTextureCanvas.width = MAP_WIDTH * CELL_SIZE;
    floorTextureCanvas.height = MAP_HEIGHT * CELL_SIZE;
    const fc = floorTextureCanvas.getContext('2d');

    for (let ty = 0; ty < MAP_HEIGHT; ty++) {
        for (let tx = 0; tx < MAP_WIDTH; tx++) {
            const t = (map && map[ty]) ? map[ty][tx] : TILE_TYPES.FLOOR;
            if (t === TILE_TYPES.WALL) {
                // raised pixel-stone border: strong bevel, no sparkle
                paintPixelTile(fc, tx, ty, WALL_BASE, 32, -24, 28, 11, 9);
            } else if (t === TILE_TYPES.COUNTER) {
                paintCounterTile(fc, tx, ty);
            } else {
                const base = floorBaseColor(tx, ty);
                paintPixelTile(fc, tx, ty, base, 20, -11, 13, 13, 8);
                const h = tileHash(tx, ty, 1);
                if (h % 13 === 0) {
                    drawPixelSparkle(fc, tx * CELL_SIZE, ty * CELL_SIZE, h);
                }
            }
        }
    }
}

function drawRoundedHBar(px, py, w, h, progress01, fillColor, trackColor) {
    const r = h / 2;
    ctx.fillStyle = trackColor;
    ctx.beginPath();
    ctx.roundRect(px, py, w, h, r);
    ctx.fill();
    const clamped = Math.max(0, Math.min(1, progress01));
    let pw = clamped * w;
    if (clamped > 0 && pw < h) pw = h;
    if (pw > 0) {
        ctx.fillStyle = fillColor;
        ctx.beginPath();
        ctx.roundRect(px, py, Math.min(w, pw), h, r);
        ctx.fill();
    }
}

function pathPreviewTintForStation(info) {
    if (!info) return null;
    const t = {
        ingredientBin: COLORS.ingredientBin,
        stove: COLORS.stove,
        cuttingBoard: COLORS.cuttingBoard,
        platingArea: COLORS.platingArea,
        trash: '#37474f',
        receptionStand: COLORS.receptionStand,
        counter: COLORS.counter
    };
    return t[info.type] || null;
}

function standNumberFromStandId(standId) {
    const m = /^reception_(\d+)$/.exec(standId);
    return m ? parseInt(m[1], 10) + 1 : 0;
}

// =============================================
// INGREDIENTS & RECIPES
// =============================================
const INGREDIENTS = ['tomato', 'lettuce', 'onion', 'meat', 'dough', 'cheese'];

const INGREDIENT_NAMES = {
    tomato: 'Tomato',
    lettuce: 'Lettuce',
    onion: 'Onion',
    meat: 'Meat',
    dough: 'Dough',
    cheese: 'Cheese'
};

const INGREDIENT_STATES = {
    RAW: 'raw',
    CHOPPED: 'chopped',
    COOKED: 'cooked',
    BURNT: 'burnt'
};

const RECIPES = {
    'Salad': {
        icon: 'SAL',
        steps: ['chop_lettuce', 'chop_tomato'],
        components: [
            { ingredient: 'lettuce', state: 'chopped' },
            { ingredient: 'tomato', state: 'chopped' }
        ],
        difficulty: 1,
        instructions: '1. Chop Lettuce\n2. Chop Tomato\n3. Plate both'
    },
    'Burger': {
        icon: 'BRG',
        steps: ['cook_meat', 'plate_with_bun'],
        components: [
            { ingredient: 'meat', state: 'cooked' },
            { ingredient: 'dough', state: 'raw' }
        ],
        difficulty: 2,
        instructions: '1. Cook Meat on Stove\n2. Get Dough (bun)\n3. Plate both'
    },
    'Steak': {
        icon: 'STK',
        steps: ['cook_meat'],
        components: [
            { ingredient: 'meat', state: 'cooked' }
        ],
        difficulty: 1,
        instructions: '1. Cook Meat on Stove\n2. Plate when ready'
    },
    'Pizza': {
        icon: 'PZZ',
        steps: ['cook_dough', 'add_cheese', 'add_tomato'],
        components: [
            { ingredient: 'dough', state: 'cooked' },
            { ingredient: 'cheese', state: 'raw' },
            { ingredient: 'tomato', state: 'chopped' }
        ],
        difficulty: 3,
        instructions: '1. Cook Dough on Stove\n2. Chop Tomato\n3. Get Cheese\n4. Plate all three'
    },
    'Deluxe Burger': {
        icon: 'DBR',
        steps: ['chop_onion', 'cook_meat', 'plate_all'],
        components: [
            { ingredient: 'meat', state: 'cooked' },
            { ingredient: 'dough', state: 'raw' },
            { ingredient: 'onion', state: 'chopped' }
        ],
        difficulty: 3,
        instructions: '1. Chop Onion\n2. Cook Meat\n3. Get Dough\n4. Plate all three'
    },
    'Feast Platter': {
        icon: 'FST',
        steps: ['cook_meat', 'chop_lettuce', 'chop_tomato', 'cheese_plate'],
        components: [
            { ingredient: 'meat', state: 'cooked' },
            { ingredient: 'lettuce', state: 'chopped' },
            { ingredient: 'tomato', state: 'chopped' },
            { ingredient: 'cheese', state: 'raw' }
        ],
        difficulty: 4,
        instructions: '1. Cook Meat\n2. Chop Lettuce & Tomato\n3. Add Cheese on plate\n4. Deliver'
    },
    'Supreme Pizza': {
        icon: 'SPZ',
        steps: ['cook_dough', 'chop_tomato', 'chop_onion', 'cheese_plate'],
        components: [
            { ingredient: 'dough', state: 'cooked' },
            { ingredient: 'tomato', state: 'chopped' },
            { ingredient: 'onion', state: 'chopped' },
            { ingredient: 'cheese', state: 'raw' }
        ],
        difficulty: 4,
        instructions: '1. Cook Dough\n2. Chop Tomato & Onion\n3. Cheese on plate\n4. Deliver'
    }
};

const RECIPE_NAMES_BY_PHASE = {
    tutorial: ['Salad', 'Steak'],
    ramp: ['Salad', 'Steak', 'Burger']
};

function matchPlateToDish(items) {
    if (!items || items.length === 0) return null;
    const sortedItems = items.slice().sort((a, b) =>
        (a.ingredient || '').localeCompare(b.ingredient || '')
    );
    for (const [name, recipe] of Object.entries(RECIPES)) {
        const comps = recipe.components;
        if (comps.length !== sortedItems.length) continue;
        const sortedComps = comps.slice().sort((a, b) =>
            a.ingredient.localeCompare(b.ingredient)
        );
        let ok = true;
        for (let i = 0; i < sortedComps.length; i++) {
            if (sortedComps[i].ingredient !== sortedItems[i].ingredient ||
                sortedComps[i].state !== sortedItems[i].state) {
                ok = false;
                break;
            }
        }
        if (ok) return name;
    }
    return null;
}

function drawDishIcon(dishName, x, y, w, h) {
    const path = SKIN_SOURCES.order[dishName];
    return !!(path && SkinStore.draw(path, x, y, w, h, 'contain'));
}

function drawIngredientIconCircle(ingredient, cx, cy, radius) {
    const path = SKIN_SOURCES.ingredient[ingredient];
    const size = radius * 2.2;
    if (path && SkinStore.draw(path, cx - size / 2, cy - size / 2, size, size)) return;
    ctx.fillStyle = COLORS[ingredient] || '#888';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
}

// =============================================
// MAP LAYOUT - Restaurant Style
// =============================================
const TILE_TYPES = {
    FLOOR: 0,
    WALL: 1,
    COUNTER: 2,
    INGREDIENT_BIN: 3,
    STOVE: 4,
    CUTTING_BOARD: 5,
    PLATING_AREA: 6,
    TRASH: 9,
    RECEPTION_STAND: 7
};

// Station definitions with positions
const stations = {
    ingredientBins: [],
    stoves: [],
    cuttingBoards: [],
    platingAreas: [],
    counters: [],
    trashCans: [],
    receptionStands: []
};

// Create map array
const map = [];
for (let y = 0; y < MAP_HEIGHT; y++) {
    map[y] = [];
    for (let x = 0; x < MAP_WIDTH; x++) {
        map[y][x] = TILE_TYPES.FLOOR;
    }
}

// Build walls around edges
for (let x = 0; x < MAP_WIDTH; x++) {
    map[0][x] = TILE_TYPES.WALL;
    map[MAP_HEIGHT - 1][x] = TILE_TYPES.WALL;
}
for (let y = 0; y < MAP_HEIGHT; y++) {
    map[y][0] = TILE_TYPES.WALL;
    map[y][MAP_WIDTH - 1] = TILE_TYPES.WALL;
}

// Kitchen/Reception divider (vertical counter)
for (let y = 1; y < MAP_HEIGHT - 1; y++) {
    map[y][13] = TILE_TYPES.COUNTER;
}
// Pass-through window
map[6][13] = TILE_TYPES.FLOOR;
map[7][13] = TILE_TYPES.FLOOR;

// Top counter in kitchen
for (let x = 1; x < 13; x++) {
    map[1][x] = TILE_TYPES.COUNTER;
}

// Place ingredient bins along left wall - 6 bins stacked
const ingredientPositions = [
    { x: 1, y: 3, ingredient: 'tomato' },
    { x: 1, y: 5, ingredient: 'lettuce' },
    { x: 1, y: 7, ingredient: 'onion' },
    { x: 1, y: 9, ingredient: 'meat' },
    { x: 1, y: 11, ingredient: 'dough' },
    { x: 3, y: 11, ingredient: 'cheese' }
];

ingredientPositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.INGREDIENT_BIN;
    stations.ingredientBins.push({
        id: `bin_${i}`,
        name: INGREDIENT_NAMES[pos.ingredient],
        x: pos.x,
        y: pos.y,
        ingredient: pos.ingredient
    });
});

// Place stoves (3) - along top counter
const stovePositions = [
    { x: 4, y: 1 }, { x: 6, y: 1 }, { x: 8, y: 1 }
];
stovePositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.STOVE;
    stations.stoves.push({
        id: `stove_${i}`,
        name: `Stove ${i + 1}`,
        x: pos.x,
        y: pos.y,
        cooking: null,
        cookTime: 0,
        maxCookTime: 4,
        busy: false
    });
});

// Place cutting boards (2) - middle of kitchen
const cuttingPositions = [
    { x: 5, y: 5 }, { x: 8, y: 5 }
];
cuttingPositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.CUTTING_BOARD;
    stations.cuttingBoards.push({
        id: `cutting_${i}`,
        name: `Cutting Board ${i + 1}`,
        x: pos.x,
        y: pos.y,
        processing: null,
        processTime: 0,
        maxProcessTime: 2,
        busy: false
    });
});

// Place plating areas (4) - near pass-through and where the old dish rack / sink sat
const platingPositions = [
    { x: 10, y: 5 }, { x: 10, y: 8 }, { x: 11, y: 5 }, { x: 3, y: 5 }
];
platingPositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.PLATING_AREA;
    stations.platingAreas.push({
        id: `plating_${i}`,
        name: `Plating Area ${i + 1}`,
        x: pos.x,
        y: pos.y,
        items: [],
        busy: false
    });
});

// Place a trash can
const trashPos = { x: 3, y: 9 };
map[trashPos.y][trashPos.x] = TILE_TYPES.TRASH;
stations.trashCans.push({ id: 'trash_0', x: trashPos.x, y: trashPos.y });

// 5 stools for customers
const receptionPositions = [
    { x: 17, y: 3 }, { x: 17, y: 5 }, { x: 17, y: 7 }, { x: 17, y: 9 }, { x: 17, y: 11 }
];
receptionPositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.RECEPTION_STAND;
    stations.receptionStands.push({
        id: `reception_${i}`,
        name: `Counter ${i + 1}`,
        x: pos.x,
        y: pos.y,
        order: null,
        customer: null // { timeLeft }
    });
});

// Register all counter tiles into stations.counters so chefs can place temporary items
for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
        if (map[y][x] === TILE_TYPES.COUNTER) {
            stations.counters.push({ id: `counter_${stations.counters.length}`, x, y, items: [] });
        }
    }
}

// =============================================
// CHEFS
// =============================================
const chefs = [];
const chefStartPositions = [
    { x: 4, y: 8 },
    { x: 6, y: 8 },
    { x: 8, y: 8 },
    { x: 5, y: 10 },
    { x: 7, y: 10 }
];

const CHEF_NAMES = ['Red', 'Green', 'Blue', 'Orange', 'Purple'];

function initChefs() {
    chefs.length = 0;
    chefStartPositions.forEach((pos, i) => {
        chefs.push({
            id: i,
            name: CHEF_NAMES[i],
            x: pos.x,
            y: pos.y,
            targetX: null,
            targetY: null,
            path: [],
            blockedTicks: 0,
            holding: null,
            busy: false,
            actionTimer: 0,
            moveTimer: 0,
            waitingAt: null,
            waitingAtStove: null,
            boostActive: false,
            boostTime: 0,
            boostCooldown: 0
        });
    });
}

// =============================================
// ORDERS
// =============================================
const orders = [];
let orderIdCounter = 0;

function standFreeForOrder(s) {
    return !s.order && !s.customer;
}

function failOrderNoStandSlot() {
    GameState.failedOrders++;
    ScoreGuard.applyDelta(-50, 'no-stand-slot');
    GameState.streak = 0;
    showFloatingText(10, 7, 'No room! Order lost!', '#f44336', { fontSize: 22, life: 3, maxLife: 3, drift: 0 });
}

/** @returns {boolean} true if a spawn was resolved (new order or high-pressure penalty) */
function spawnOrder() {
    const phase = getPhaseKey(GameState.time);
    const availableStands = stations.receptionStands.filter(standFreeForOrder);

    if (availableStands.length === 0) {
        if (isHighPressurePhase(phase)) {
            failOrderNoStandSlot();
            return true;
        }
        return false;
    }

    const stand = availableStands[Math.floor(Math.random() * availableStands.length)];

    const names = getRecipeNamesForSpawn(GameState.time);
    const recipeEntries = names
        ? names.map(name => [name, RECIPES[name]])
        : Object.entries(RECIPES);
    const [dishName, recipe] = recipeEntries[Math.floor(Math.random() * recipeEntries.length)];

    const timeLimit = orderTimeLimitForSpawn(GameState.time);

    const vip = Math.random() < Math.min(0.16, 0.07 + GameState.time / 9000);

    const order = {
        id: orderIdCounter++,
        dish: dishName,
        icon: recipe.icon || RECIPE_ICON_BY_NAME[dishName] || 'ORD',
        recipe: recipe,
        timeLeft: vip ? Math.floor(timeLimit * 0.85) : timeLimit,
        maxTime: vip ? Math.floor(timeLimit * 0.85) : timeLimit,
        vip: vip,
        standId: stand.id
    };

    stand.order = order;
    orders.push(order);

    EventBus.emit('orderSpawned', {
        id: order.id,
        dish: order.dish,
        timeLeft: order.timeLeft,
        standId: order.standId,
        components: order.recipe.components.map(c => ({ ingredient: c.ingredient, state: c.state }))
    });
    return true;
}

// =============================================
// PATHFINDING (A*)
// =============================================
function findPath(startX, startY, endX, endY, avoid) {
    const openSet = [];
    const closedSet = new Set();
    const cameFrom = {};
    
    const gScore = {};
    const fScore = {};
    
    const startKey = `${startX},${startY}`;
    gScore[startKey] = 0;
    fScore[startKey] = heuristic(startX, startY, endX, endY);
    
    openSet.push({ x: startX, y: startY, f: fScore[startKey] });
    
    while (openSet.length > 0) {
        openSet.sort((a, b) => a.f - b.f);
        const current = openSet.shift();
        const currentKey = `${current.x},${current.y}`;
        
        if (current.x === endX && current.y === endY) {
            return reconstructPath(cameFrom, current);
        }
        
        closedSet.add(currentKey);
        
        const neighbors = getNeighbors(current.x, current.y, avoid);
        for (const neighbor of neighbors) {
            const neighborKey = `${neighbor.x},${neighbor.y}`;
            if (closedSet.has(neighborKey)) continue;
            
            const tentativeG = gScore[currentKey] + 1;
            
            if (!gScore[neighborKey] || tentativeG < gScore[neighborKey]) {
                cameFrom[neighborKey] = current;
                gScore[neighborKey] = tentativeG;
                fScore[neighborKey] = tentativeG + heuristic(neighbor.x, neighbor.y, endX, endY);
                
                if (!openSet.find(n => n.x === neighbor.x && n.y === neighbor.y)) {
                    openSet.push({ x: neighbor.x, y: neighbor.y, f: fScore[neighborKey] });
                }
            }
        }
    }
    
    return []; // No path found
}

function heuristic(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

function getNeighbors(x, y, avoid) {
    const neighbors = [];
    const directions = [[0, -1], [0, 1], [-1, 0], [1, 0]];

    for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;

        if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT) {
            if (isWalkable(nx, ny) && !(avoid && avoid.has(`${nx},${ny}`))) {
                neighbors.push({ x: nx, y: ny });
            }
        }
    }
    
    return neighbors;
}

function isWalkable(x, y) {
    const tile = map[y][x];
    return tile === TILE_TYPES.FLOOR;
}

function reconstructPath(cameFrom, current) {
    const path = [{ x: current.x, y: current.y }];
    let key = `${current.x},${current.y}`;
    
    while (cameFrom[key]) {
        current = cameFrom[key];
        path.unshift({ x: current.x, y: current.y });
        key = `${current.x},${current.y}`;
    }
    
    return path.slice(1); // Remove start position
}

// Find walkable tile adjacent to station
function findAdjacentWalkable(stationX, stationY) {
    const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    
    for (const [dx, dy] of directions) {
        const nx = stationX + dx;
        const ny = stationY + dy;
        
        if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT && isWalkable(nx, ny)) {
            return { x: nx, y: ny };
        }
    }
    
    return null;
}

/** True if chef is on a walkable tile orthogonally adjacent to the station cell. */
function isChefAdjacentToStation(chefX, chefY, stationX, stationY) {
    const manhattan = Math.abs(chefX - stationX) + Math.abs(chefY - stationY);
    return manhattan === 1 && isWalkable(chefX, chefY);
}

// =============================================
// STATION INTERACTIONS
// =============================================
function getStationAt(x, y) {
    // Check all station types
    for (const bin of stations.ingredientBins) {
        if (bin.x === x && bin.y === y) return { type: 'ingredientBin', station: bin };
    }
    for (const stove of stations.stoves) {
        if (stove.x === x && stove.y === y) return { type: 'stove', station: stove };
    }
    for (const board of stations.cuttingBoards) {
        if (board.x === x && board.y === y) return { type: 'cuttingBoard', station: board };
    }
    for (const counter of stations.counters) {
        if (counter.x === x && counter.y === y) return { type: 'counter', station: counter };
    }
    for (const trash of stations.trashCans) {
        if (trash.x === x && trash.y === y) return { type: 'trash', station: trash };
    }
    for (const plate of stations.platingAreas) {
        if (plate.x === x && plate.y === y) return { type: 'platingArea', station: plate };
    }
    for (const stand of stations.receptionStands) {
        if (stand.x === x && stand.y === y) return { type: 'receptionStand', station: stand };
    }
    return null;
}

function interactWithStation(chef, stationInfo) {
    const { type, station } = stationInfo;
    
    switch (type) {
        case 'ingredientBin':
            // Pick up ingredient
            if (!chef.holding) {
                chef.holding = {
                    ingredient: station.ingredient,
                    state: INGREDIENT_STATES.RAW
                };
                showFloatingText(chef.x, chef.y, `+${station.ingredient}`, COLORS[station.ingredient]);
            }
            break;

        case 'counter':
            // Place or pick up items on counters (one item max). Allow combining plate <-> ingredient.
            station.items = station.items || [];
            if (chef.holding) {
                // Trying to put something onto the counter
                if (station.items.length >= 1) {
                    const top = station.items[station.items.length - 1];
                    // If counter has a plate and chef holds an ingredient, add ingredient to plate
                    if (top.type === 'plate' && chef.holding.type !== 'plate') {
                        top.items.push(chef.holding);
                        showFloatingText(station.x, station.y, `Added ${chef.holding.ingredient} to plate: ${plateSummary(top)}`, '#4caf50');
                        chef.holding = null;
                        return;
                    }
                    // If chef holds a plate and counter has an ingredient, add ingredient to the plate
                    if (chef.holding.type === 'plate' && top.type !== 'plate') {
                        chef.holding.items.push(top);
                        station.items.pop();
                        showFloatingText(station.x, station.y, `PLATE Combined: ${plateSummary(chef.holding)}`, '#4caf50');
                        return;
                    }

                    // Otherwise full / incompatible
                    showFloatingText(station.x, station.y, 'Counter is full, remove the item first', '#ffb74d');
                    return;
                }

                // Empty counter: place item
                station.items.push(chef.holding);
                if (chef.holding.type === 'plate') {
                    showFloatingText(station.x, station.y, `PLATE placed: ${plateSummary(chef.holding)}`, '#ffd54f');
                } else {
                    showFloatingText(station.x, station.y, `Placed ${chef.holding.ingredient}`, '#ffd54f');
                }
                chef.holding = null;

            } else if (!chef.holding && station.items && station.items.length > 0) {
                // Pick up the top item
                const item = station.items.pop();
                chef.holding = item;
                if (item.type === 'plate') {
                    showFloatingText(chef.x, chef.y, `Picked up plate: ${plateSummary(item)}`, '#fff');
                } else {
                    showFloatingText(chef.x, chef.y, `Picked up ${item.ingredient}`, '#fff');
                }
            }
            break;

        case 'cuttingBoard':
            // Chop held ingredient or pick up chopped
            if (station.processing && station.processTime >= station.maxProcessTime) {
                // Pick up finished item
                if (!chef.holding) {
                    chef.holding = station.processing;
                    chef.holding.state = INGREDIENT_STATES.CHOPPED;
                    station.processing = null;
                    station.processTime = 0;
                    station.busy = false;
                    showFloatingText(chef.x, chef.y, '✓ Chopped!', '#4caf50');
                }
            } else if (chef.holding && chef.holding.state === INGREDIENT_STATES.RAW && !station.busy) {
                // Restriction: do not allow chopping dough (no slicing bread)
                if (chef.holding.ingredient === 'dough') {
                    showFloatingText(station.x, station.y, 'No slicing bread! 🍞', '#ffb74d');
                    return;
                }

                station.processing = chef.holding;
                station.processTime = 0;
                station.busy = true;
                chef.holding = null;
                chef.busy = true;
                chef.actionTimer = station.maxProcessTime;
                chef.waitingAt = station;
                showFloatingText(station.x, station.y, 'Chopping...', '#fff');
            }
            break;
            
        case 'stove':
            // Cook held ingredient or pick up cooked item
            if (station.cooking) {
                const cookProgress = station.cookTime / station.maxCookTime;
                if (cookProgress >= 0.8 && !chef.holding) {
                    // Pick up cooked item
                    chef.holding = station.cooking;
                    chef.holding.state = station.cookTime >= station.maxCookTime * 1.5 
                        ? INGREDIENT_STATES.BURNT 
                        : INGREDIENT_STATES.COOKED;
                    
                    const msg = chef.holding.state === INGREDIENT_STATES.BURNT ? 'Burnt!' : 'Cooked!';
                    const color = chef.holding.state === INGREDIENT_STATES.BURNT ? '#f44336' : '#4caf50';
                    showFloatingText(chef.x, chef.y, msg, color);
                    
                    station.cooking = null;
                    station.cookTime = 0;
                    station.busy = false;
                }
            } else if (chef.holding && !station.busy) {
                // Put item on stove and wait for it to cook
                station.cooking = chef.holding;
                station.cookTime = 0;
                station.busy = true;
                chef.holding = null;
                chef.busy = true;
                chef.actionTimer = station.maxCookTime; // Wait for cooking
                chef.waitingAtStove = station;
                showFloatingText(station.x, station.y, 'Cooking...', '#ff9800');
            }
            break;

        case 'platingArea':
            // Plates are infinite. Ingredients accumulate on the area; picking up wraps them in a plate.
            if (chef.holding && chef.holding.type !== 'plate') {
                if (chef.holding.ingredient === 'meat' && chef.holding.state === INGREDIENT_STATES.RAW) {
                    showFloatingText(station.x, station.y, 'No serving raw meat! Cook it first.', '#ffb74d');
                    return;
                }
                station.items.push(chef.holding);
                showFloatingText(station.x, station.y, `+1 (${station.items.length} items)`, '#2196f3');
                chef.holding = null;
            } else if (chef.holding && chef.holding.type === 'plate') {
                // Merge the held plate's items into the plating area.
                station.items = station.items.concat(chef.holding.items || []);
                chef.holding = null;
                showFloatingText(station.x, station.y, `Merged (${station.items.length} items)`, '#4caf50');
            } else if (!chef.holding && station.items.length > 0) {
                chef.holding = { type: 'plate', items: [...station.items] };
                station.items = [];
                showFloatingText(chef.x, chef.y, `Plate ready: ${plateSummary(chef.holding)}`, '#2196f3');
            }
            break;
        case 'receptionStand':
            // Deliver dish
            if (chef.holding && chef.holding.type === 'plate' && station.order) {
                const success = checkDelivery(chef.holding, station.order);
                if (success) {
                    const timeBonus = Math.floor(station.order.timeLeft * 2);
                    const baseScore = 100 * GameState.difficulty;
                    const streakMultiplier = 1 + Math.min(1.0, GameState.streak * 0.05);
                    const vipMultiplier = station.order.vip ? 1.5 : 1;
                    const totalScore = Math.floor((baseScore + timeBonus) * streakMultiplier * vipMultiplier);
                    ScoreGuard.applyDelta(totalScore, 'delivery');
                    GameState.streak += 1;
                    GameState.bestStreak = Math.max(GameState.bestStreak, GameState.streak);
                    GameState.ordersDelivered += 1;

                    const vipTag = station.order.vip ? ' VIP' : '';
                    showFloatingText(station.x, station.y, `+${totalScore}!${vipTag}`, '#4caf50', { kind: 'score', fontSize: 22 });

                    // Start customer eating lifecycle
                    const deliveredOrder = station.order;
                    station.order = null;
                    const orderIndex = orders.indexOf(deliveredOrder);
                    if (orderIndex > -1) orders.splice(orderIndex, 1);
                    station.customer = { timeLeft: 10 }; // seconds to eat

                    EventBus.emit('orderDelivered', {
                        id: deliveredOrder.id,
                        dish: deliveredOrder.dish,
                        score: totalScore,
                        streak: GameState.streak
                    });
                } else {
                    EventBus.emit('orderFailed', { dish: station.order.dish });
                    showFloatingText(station.x, station.y, 'Wrong dish!', '#f44336', { kind: 'error' });
                    GameState.streak = 0;
                }
                chef.holding = null;
            }
            break;

        case 'trash':
            if (chef.holding) {
                chef.holding = null;
                showFloatingText(chef.x, chef.y, 'Trashed', '#9e9e9e');
            }
            break;
    }
}

function checkDelivery(plate, order) {
    const required = order.recipe.components;
    const delivered = plate.items;
    
    if (delivered.length !== required.length) return false;
    
    // Check each required component
    for (const req of required) {
        const found = delivered.find(
            item => item.ingredient === req.ingredient && item.state === req.state
        );
        if (!found) return false;
    }
    
    return true;
}

function plateSummary(plate) {
    if (!plate || !plate.items || plate.items.length === 0) return 'empty';
    return plate.items.map(i => i.ingredient).join(', ');
}


// =============================================
// FLOATING TEXT
// =============================================
const floatingTexts = [];

function showFloatingText(x, y, text, color, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize != null ? opts.fontSize : 14;
    const life = opts.life != null ? opts.life : 1.5;
    const drift = opts.drift != null ? opts.drift : 30;
    floatingTexts.push({
        x: x * CELL_SIZE + CELL_SIZE / 2,
        y: y * CELL_SIZE,
        text: text,
        color: color,
        life: life,
        maxLife: life,
        fontSize: fontSize,
        drift: drift,
        kind: opts.kind || null
    });
}

function updateFloatingTexts(dt) {
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        floatingTexts[i].life -= dt;
        const drift = floatingTexts[i].drift != null ? floatingTexts[i].drift : 30;
        floatingTexts[i].y -= drift * dt;
        if (floatingTexts[i].life <= 0) {
            floatingTexts.splice(i, 1);
        }
    }
}

function drawFloatingTexts() {
    const fontFamily = 'Inter, system-ui, sans-serif';
    for (const ft of floatingTexts) {
        const alpha = ft.life / ft.maxLife;
        const fontPx = ft.fontSize || 14;
        const isScore = ft.kind === 'score' || (/^\+\d/.test(ft.text) && ft.color === '#4caf50');
        const usePx = isScore ? Math.max(fontPx, 20) : fontPx;
        ctx.font = 'bold ' + usePx + 'px ' + fontFamily;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const metrics = ctx.measureText(ft.text);
        const padX = 8;
        const padY = 4;
        const w = metrics.width + padX * 2;
        const h = usePx + padY * 2;
        let bg = 'rgba(0,0,0,0.6)';
        if (ft.kind === 'error' || (ft.text.includes('Wrong') && ft.color === '#f44336')) {
            bg = 'rgba(183, 28, 28, 0.88)';
        } else if (ft.kind === 'phase') {
            bg = 'rgba(0,0,0,0.75)';
        }

        let scale = 1;
        if (ft.kind === 'phase') {
            const age = 1 - ft.life / ft.maxLife;
            scale = 0.82 + 0.18 * Math.min(1, age * 6);
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        const bx = ft.x - w / 2;
        const by = ft.y - h / 2;
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.roundRect(bx, by, w, h, 8);
        ctx.fill();

        ctx.translate(ft.x, ft.y);
        ctx.scale(scale, scale);
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, 0, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
    }
}

// =============================================
// GAME LOOP
// =============================================
let lastTime = 0;

function gameLoop(currentTime) {
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    if (GameState.running && !GameState.paused) {
        update(deltaTime);
    }

    render();
    requestAnimationFrame(gameLoop);
}

function update(dt) {
    GameState.time += dt;

    GameState.difficulty = computeDifficulty(GameState.time);

    if (!GameState.phaseBanner60 && GameState.time >= 60) {
        GameState.phaseBanner60 = true;
        showFloatingText(10, 7, 'PHASE UP: PICKING UP THE PACE!', '#ffeb3b', { fontSize: 28, life: 3, maxLife: 3, drift: 0, kind: 'phase' });
    }
    if (!GameState.phaseBanner150 && GameState.time >= 150) {
        GameState.phaseBanner150 = true;
        showFloatingText(10, 7, 'AUTOMATION CHECK: KEEP UP!', '#f44336', { fontSize: 28, life: 3, maxLife: 3, drift: 0, kind: 'phase' });
    }
    if (!GameState.phaseBanner600Float && GameState.time >= 600) {
        GameState.phaseBanner600Float = true;
        showFloatingText(10, 7, 'ENDURANCE MODE', '#ffc107', { fontSize: 28, life: 4, maxLife: 4, drift: 0, kind: 'phase' });
    }

    if (GameState.time >= 600) {
        ScoreGuard.applyDelta(dt * GameState.difficulty, 'endurance-tick');
    }

    const phase = getPhaseKey(GameState.time);

    if (GameState.rush.active) {
        GameState.rush.timeLeft -= dt;
        if (GameState.rush.timeLeft <= 0) {
            GameState.rush.active = false;
            GameState.rush.cooldown = isHighPressurePhase(phase)
                ? 15 + Math.random() * 5
                : 30 + Math.random() * 25;
        }
    } else {
        GameState.rush.cooldown -= dt;
        if (GameState.rush.cooldown <= 0) {
            GameState.rush.active = true;
            GameState.rush.timeLeft = isHighPressurePhase(phase)
                ? 12 + Math.random() * 8
                : 10 + Math.random() * 6;
            showFloatingText(12, 2, 'RUSH HOUR!', '#ffd54f');
        }
    }

    const spawnEvery = baseOrderSpawnInterval(GameState.time, GameState.rush.active);
    GameState.orderSpawnDebt += dt / spawnEvery;
    let spawnsThisFrame = 0;
    const maxSpawnsPerFrame = 2;
    while (GameState.orderSpawnDebt >= 1 && spawnsThisFrame < maxSpawnsPerFrame) {
        if (!spawnOrder()) {
            break;
        }
        GameState.orderSpawnDebt -= 1;
        spawnsThisFrame++;
    }
    
    // Update chefs
    for (const chef of chefs) {
        updateChef(chef, dt);
    }
    
    // Update stations
    updateStations(dt);
    
    // Update orders
    updateOrders(dt);
    
    // Update floating texts
    updateFloatingTexts(dt);
    
    // Check game over
    if (GameState.failedOrders >= GameState.maxFailedOrders) {
        endGame();
    }

    const apiPhase = getApiPhase(GameState.time);
    if (apiPhase !== lastEmittedPhase) {
        lastEmittedPhase = apiPhase;
        EventBus.emit('phaseChanged', { phase: apiPhase });
    }

    EventBus.emit('tick', { dt, time: GameState.time });
    ScoreGuard.tick(GameState.time);
    
    // Update UI
    updateUI();
}

function updateChef(chef, dt) {
    if (chef.boostCooldown > 0) {
        chef.boostCooldown = Math.max(0, chef.boostCooldown - dt);
    }
    if (chef.boostActive) {
        chef.boostTime -= dt;
        if (chef.boostTime <= 0) {
            chef.boostActive = false;
            chef.boostTime = 0;
        }
    }

    if (chef.actionTimer > 0) {
        chef.actionTimer -= dt;
        if (chef.actionTimer <= 0) {
            chef.busy = false;
            // Pick up processed item from cutting board
            if (chef.waitingAt) {
                if (chef.waitingAt.processing) {
                    chef.holding = chef.waitingAt.processing;
                    chef.holding.state = INGREDIENT_STATES.CHOPPED;
                    chef.waitingAt.processing = null;
                    chef.waitingAt.busy = false;
                    showFloatingText(chef.x, chef.y, '✓ Chopped!', '#4caf50');
                }
                chef.waitingAt = null;
            }
            // Pick up cooked item from stove
            if (chef.waitingAtStove) {
                if (chef.waitingAtStove.cooking) {
                    chef.holding = chef.waitingAtStove.cooking;
                    chef.holding.state = INGREDIENT_STATES.COOKED;
                    chef.waitingAtStove.cooking = null;
                    chef.waitingAtStove.busy = false;
                    showFloatingText(chef.x, chef.y, '✓ Cooked!', '#4caf50');
                }
                chef.waitingAtStove = null;
            }
        }
        return;
    }
    
    // Each chef has their own move timer
    chef.moveTimer += dt;
    
    const moveDelay = chef.boostActive ? GameState.moveDelay * 0.5 : GameState.moveDelay;
    // Move along path with delay
    if (chef.path.length > 0 && chef.moveTimer >= moveDelay) {
        const next = chef.path[0];

        // Check if another chef is at the target
        const blocked = chefs.some(c => c !== chef && c.x === next.x && c.y === next.y);

        const step = () => {
            chef.x = next.x;
            chef.y = next.y;
            chef.path.shift();
            chef.blockedTicks = 0;

            // Check if reached destination
            if (chef.path.length === 0 && chef.targetStation) {
                interactWithStation(chef, chef.targetStation);
                chef.targetStation = null;
            }
        };

        if (!blocked) {
            step();
        } else {
            chef.blockedTicks++;
            // Stuck on another chef: try to route around it, then force through
            // to break swap deadlocks where no alternate route exists.
            if (chef.blockedTicks >= 3) {
                const dest = chef.path[chef.path.length - 1];
                const avoid = new Set(
                    chefs.filter(c => c !== chef).map(c => `${c.x},${c.y}`)
                );
                const detour = findPath(chef.x, chef.y, dest.x, dest.y, avoid);
                if (detour.length > 0) {
                    chef.path = detour;
                    chef.blockedTicks = 0;
                } else {
                    step();
                }
            }
        }
        chef.moveTimer = 0;
    }
}

function updateStations(dt) {
    // Update stoves
    for (const stove of stations.stoves) {
        if (stove.cooking) {
            stove.cookTime += dt;
            
            // Auto-burn after too long
            if (stove.cookTime >= stove.maxCookTime * 2) {
                stove.cooking.state = INGREDIENT_STATES.BURNT;
            }
        }
    }
    
    // Update cutting boards
    for (const board of stations.cuttingBoards) {
        if (board.processing && board.busy) {
            board.processTime += dt;
        }
    }

    // Update reception stands (customer eats, then leaves)
    for (const stand of stations.receptionStands) {
        if (stand.customer) {
            stand.customer.timeLeft -= dt;
            if (stand.customer.timeLeft <= 0) {
                stand.customer = null;
            }
        }
    }
}

function updateOrders(dt) {
    for (let i = orders.length - 1; i >= 0; i--) {
        orders[i].timeLeft -= dt;
        
        if (orders[i].timeLeft <= 0) {
            // Order expired
            const expired = orders[i];
            EventBus.emit('orderExpired', {
                id: expired.id,
                dish: expired.dish,
                standId: expired.standId
            });

            GameState.failedOrders++;
            ScoreGuard.applyDelta(-50, 'order-expired');
            GameState.streak = 0;
            
            showFloatingText(
                stations.receptionStands.find(s => s.order === expired)?.x || 17,
                stations.receptionStands.find(s => s.order === expired)?.y || 6,
                'Order expired!', '#f44336'
            );
            
            // Clear from stand
            const stand = stations.receptionStands.find(s => s.order === expired);
            if (stand) stand.order = null;
            
            orders.splice(i, 1);
        }
    }
}

// =============================================
// RENDERING
// =============================================
function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (floorImg.complete && floorImg.naturalWidth > 0) {
        ctx.drawImage(floorImg, 0, 0);
    } else {
        if (!floorTextureCanvas) buildFloorTexture();
        ctx.drawImage(floorTextureCanvas, 0, 0);
    }
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            if (map[y][x] !== TILE_TYPES.FLOOR) {
                drawTile(x, y, map[y][x]);
            }
        }
    }
    
    drawStations();
    
    for (const chef of chefs) {
        drawChef(chef);
    }

    drawCounters();
    
    if (GameState.selectedChef !== null) {
        const chef = chefs[GameState.selectedChef];
        if (chef.path.length > 0) {
            const cx = chef.x * CELL_SIZE + CELL_SIZE / 2;
            const cy = chef.y * CELL_SIZE + CELL_SIZE / 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            for (const p of chef.path) {
                ctx.lineTo(p.x * CELL_SIZE + CELL_SIZE / 2, p.y * CELL_SIZE + CELL_SIZE / 2);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = 'rgba(255,255,255,0.45)';
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fill();
            for (const p of chef.path) {
                const px = p.x * CELL_SIZE + CELL_SIZE / 2;
                const py = p.y * CELL_SIZE + CELL_SIZE / 2;
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            const last = chef.path[chef.path.length - 1];
            const lx = last.x * CELL_SIZE;
            const ly = last.y * CELL_SIZE;
            const stationTint = pathPreviewTintForStation(getStationAt(last.x, last.y));
            const tint = stationTint || 'rgba(255,255,255,0.85)';
            ctx.strokeStyle = tint;
            ctx.lineWidth = 2;
            ctx.strokeRect(lx + 6, ly + 6, CELL_SIZE - 12, CELL_SIZE - 12);
            ctx.strokeStyle = tint;
            ctx.beginPath();
            ctx.moveTo(lx + CELL_SIZE / 2 - 8, ly + CELL_SIZE / 2);
            ctx.lineTo(lx + CELL_SIZE / 2 + 8, ly + CELL_SIZE / 2);
            ctx.moveTo(lx + CELL_SIZE / 2, ly + CELL_SIZE / 2 - 8);
            ctx.lineTo(lx + CELL_SIZE / 2, ly + CELL_SIZE / 2 + 8);
            ctx.stroke();
        }
    }
    
    drawFloatingTexts();
    
    drawLabels();
}

function drawTile(x, y, type) {
    const px = x * CELL_SIZE;
    const py = y * CELL_SIZE;
    
    let color;
    switch (type) {
        case TILE_TYPES.WALL:
        case TILE_TYPES.COUNTER:
            return; // walls & counters are baked into the pixel floor texture
        default:
            color = COLORS.floor;
    }
    
    ctx.fillStyle = color;
    ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
}

function drawStations() {
    for (const bin of stations.ingredientBins) {
        const px = bin.x * CELL_SIZE;
        const py = bin.y * CELL_SIZE;
        const pad = 4;
        const icon = INGREDIENT_ICONS[bin.ingredient] || 'BIN';

        ctx.fillStyle = COLORS.ingredientBin;
        ctx.beginPath();
        ctx.roundRect(px + pad, py + pad, CELL_SIZE - pad * 2, CELL_SIZE - pad * 2, 6);
        ctx.fill();

        /* Full inner square (same inset on all sides, was CELL_SIZE-22 height, which left a brown band) */
        const innerInset = 8;
        const innerSize = CELL_SIZE - innerInset * 2;
        const innerFill =
            bin.ingredient === 'meat'
                ? '#8d6e63'
                : COLORS[bin.ingredient] || '#fff';
        ctx.fillStyle = innerFill;
        ctx.beginPath();
        ctx.roundRect(px + innerInset, py + innerInset, innerSize, innerSize, 4);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(px + pad, py + pad, CELL_SIZE - pad * 2, CELL_SIZE - pad * 2, 6);
        ctx.stroke();

        const drewIngredientSkin = SkinStore.draw(SKIN_SOURCES.ingredient[bin.ingredient], px + 10, py + 10, CELL_SIZE - 20, CELL_SIZE - 20);
        ctx.font = 'bold 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        if (!drewIngredientSkin) ctx.fillText(icon, px + CELL_SIZE / 2, py + CELL_SIZE / 2 + 2);
    }

    for (const stove of stations.stoves) {
        const px = stove.x * CELL_SIZE;
        const py = stove.y * CELL_SIZE;

        ctx.fillStyle = stove.cooking ? COLORS.stoveOn : COLORS.stove;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        SkinStore.draw(SKIN_SOURCES.station.stove, px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        ctx.strokeStyle = stove.cooking ? '#ffeb3b' : '#666';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 12, 0, Math.PI * 2);
        ctx.stroke();

        if (stove.cooking) {
            const flicker = Math.sin(Date.now() / 100) * 2;
            ctx.fillStyle = '#ff9800';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2 + flicker, 8, 0, Math.PI * 2);
            ctx.fill();

            const progress = Math.min(1.5, stove.cookTime / stove.maxCookTime);
            ctx.fillStyle = 'rgba(255, 152, 0, 0.42)';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 16, 0, Math.PI * 2);
            ctx.fill();

            drawIngredientIconCircle(stove.cooking.ingredient, px + CELL_SIZE / 2, py + CELL_SIZE / 2, (CELL_SIZE - 28) / 2);

            let barColor;
            if (progress >= 1.2) barColor = '#f44336';
            else if (progress >= 0.8) barColor = '#4caf50';
            else barColor = '#ffeb3b';

            const barY = py + CELL_SIZE - 12;
            const barW = CELL_SIZE - 8;
            drawRoundedHBar(px + 4, barY, barW, 8, Math.min(1, progress), barColor, '#333');

            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.font = 'bold 13px Inter, system-ui, sans-serif';
            if (progress >= 1.2) {
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.fillText('BURNING!', px + CELL_SIZE / 2 + 1, py - 2 + 1);
                ctx.fillStyle = '#f44336';
                ctx.fillText('BURNING!', px + CELL_SIZE / 2, py - 3);
            } else if (progress >= 0.8) {
                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                ctx.fillText('READY!', px + CELL_SIZE / 2 + 1, py - 2 + 1);
                ctx.fillStyle = '#4caf50';
                ctx.fillText('READY!', px + CELL_SIZE / 2, py - 3);
            }
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    for (const board of stations.cuttingBoards) {
        const px = board.x * CELL_SIZE;
        const py = board.y * CELL_SIZE;

        ctx.fillStyle = COLORS.cuttingBoard;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        const drewBoardSkin = SkinStore.draw(SKIN_SOURCES.station.cuttingBoard, px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        if (!drewBoardSkin) {
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(px + 8, py + 12 + i * 10);
            ctx.lineTo(px + CELL_SIZE - 8, py + 12 + i * 10);
            ctx.stroke();
        }
        }

        if (board.processing) {
            drawIngredientIconCircle(board.processing.ingredient, px + CELL_SIZE / 2, py + CELL_SIZE / 2, (CELL_SIZE - 24) / 2);

            const progress = board.processTime / board.maxProcessTime;
            const barY = py + CELL_SIZE - 12;
            drawRoundedHBar(px + 4, barY, CELL_SIZE - 8, 8, progress, '#4caf50', '#333');

            const knifeX = px + 10 + (CELL_SIZE - 22) * progress;
            ctx.fillStyle = '#bdbdbd';
            ctx.fillRect(knifeX, py + 7, 5, 18);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    for (const plate of stations.platingAreas) {
        const px = plate.x * CELL_SIZE;
        const py = plate.y * CELL_SIZE;

        ctx.fillStyle = COLORS.platingArea;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        const drewPlatingSkin = SkinStore.draw(SKIN_SOURCES.station.platingArea, px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        if (!drewPlatingSkin) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 2;
        ctx.stroke();
        }

        let plateItems = [];
        if (plate.items.length === 1 && plate.items[0].type === 'plate') {
            plateItems = plate.items[0].items;
        } else if (plate.items.length > 0) {
            plateItems = plate.items;
        }

        if (plateItems.length > 0) {
            const dishName = matchPlateToDish(plateItems);
            const drewDish = dishName && drawDishIcon(dishName, px + 4, py + 4, CELL_SIZE - 8, CELL_SIZE - 8);
            if (!drewDish) {
                if (plateItems.length === 1) {
                    drawIngredientIconCircle(plateItems[0].ingredient, px + CELL_SIZE / 2, py + CELL_SIZE / 2, 9);
                } else {
                    const angleStep = (Math.PI * 2) / plateItems.length;
                    plateItems.forEach((item, i) => {
                        const angle = i * angleStep - Math.PI / 2;
                        const ix = px + CELL_SIZE / 2 + Math.cos(angle) * 8;
                        const iy = py + CELL_SIZE / 2 + Math.sin(angle) * 8;
                        drawIngredientIconCircle(item.ingredient, ix, iy, 7);
                    });
                }
            }

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(plateItems.length.toString(), px + CELL_SIZE - 10, py + 14);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    for (const trash of stations.trashCans) {
        const px = trash.x * CELL_SIZE;
        const py = trash.y * CELL_SIZE;
        ctx.fillStyle = '#263238';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        const drewTrashSkin = SkinStore.draw(SKIN_SOURCES.station.trash, px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        if (!drewTrashSkin) {
            ctx.font = '24px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('TRH', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
        }
    }

    for (let si = 0; si < stations.receptionStands.length; si++) {
        const stand = stations.receptionStands[si];
        const px = stand.x * CELL_SIZE;
        const py = stand.y * CELL_SIZE;
        const standNum = si + 1;

        ctx.fillStyle = COLORS.receptionStand;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        SkinStore.draw(SKIN_SOURCES.station.receptionStand, px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(px + 5, py + 5, 16, 13);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(standNum), px + 13, py + 12);

        if (stand.order) {
            const urgency = stand.order.timeLeft / stand.order.maxTime;

            if (urgency < 0.25) {
                ctx.shadowColor = 'rgba(244, 67, 54, 0.65)';
                ctx.shadowBlur = 12 + Math.sin(Date.now() / 120) * 4;
            }

            ctx.fillStyle = urgency < 0.25 ? '#f44336' : (urgency < 0.5 ? '#ff9800' : '#4caf50');
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 18, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;

            ctx.font = '18px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff';
            const drewOrderSkin = SkinStore.draw(SKIN_SOURCES.order[stand.order.dish], px + 8, py + 8, CELL_SIZE - 16, CELL_SIZE - 16);
            if (!drewOrderSkin) ctx.fillText(stand.order.icon || RECIPE_ICON_BY_NAME[stand.order.dish] || 'ORD', px + CELL_SIZE / 2, py + CELL_SIZE / 2);

            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 23, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * urgency));
            ctx.stroke();

            if (urgency < 0.25) {
                ctx.strokeStyle = `rgba(244, 67, 54, ${0.45 + Math.sin(Date.now() / 100) * 0.45})`;
                ctx.lineWidth = 3;
                ctx.strokeRect(px + 1, py + 1, CELL_SIZE - 2, CELL_SIZE - 2);
            }
        } else if (stand.customer) {
            ctx.font = 'bold 22px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#a5d6a7';
            ctx.fillText('✓', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '20px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }
}

// Draw counters separately so they render on top of chefs and stations
function drawCounters() {
    for (const counter of stations.counters) {
        const px = counter.x * CELL_SIZE;
        const py = counter.y * CELL_SIZE;

        if (counter.items && counter.items.length > 0) {
            const top = counter.items[counter.items.length - 1];
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(px + 6, py + 6, CELL_SIZE - 12, CELL_SIZE - 12);

            if (top.type === 'plate') {
                const dishName = matchPlateToDish(top.items);
                const drewDish = dishName && drawDishIcon(dishName, px + 6, py + 6, CELL_SIZE - 12, CELL_SIZE - 12);
                if (!drewDish) {
                    ctx.fillStyle = '#fff';
                    ctx.beginPath();
                    ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 12, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    if (top.items && top.items.length === 1) {
                        drawIngredientIconCircle(top.items[0].ingredient, px + CELL_SIZE / 2, py + CELL_SIZE / 2, 8);
                    } else if (top.items && top.items.length > 1) {
                        const angleStep = (Math.PI * 2) / top.items.length;
                        top.items.forEach((item, i) => {
                            const angle = i * angleStep - Math.PI / 2;
                            const ix = px + CELL_SIZE / 2 + Math.cos(angle) * 6;
                            const iy = py + CELL_SIZE / 2 + Math.sin(angle) * 6;
                            drawIngredientIconCircle(item.ingredient, ix, iy, 5);
                        });
                    } else {
                        ctx.fillStyle = '#333';
                        ctx.font = 'bold 10px Inter, system-ui, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('0', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
                    }
                }
            } else {
                drawIngredientIconCircle(top.ingredient, px + CELL_SIZE / 2, py + CELL_SIZE / 2, 9);
            }
        }
    }
}

function drawChef(chef) {
    const px = chef.x * CELL_SIZE;
    const py = chef.y * CELL_SIZE;
    const cx = px + CELL_SIZE / 2;
    const cy = py + CELL_SIZE / 2;

    let nx = 0;
    let ny = 0;
    if (chef.path.length > 0) {
        nx = chef.path[0].x - chef.x;
        ny = chef.path[0].y - chef.y;
    }
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= len;
    ny /= len;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(cx, py + CELL_SIZE - 5, 16, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    if (chef.boostActive) {
        if (nx !== 0 || ny !== 0) {
            const bx = -nx;
            const by = -ny;
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)';
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
                const side = (i - 1) * 2.5;
                const ox = bx * (10 + i * 6) + (-ny) * side;
                const oy = by * (10 + i * 6) + nx * side;
                ctx.beginPath();
                ctx.moveTo(cx + ox * 0.35, cy + oy * 0.35);
                ctx.lineTo(cx + ox, cy + oy);
                ctx.stroke();
            }
        }
        ctx.strokeStyle = 'rgba(255, 213, 79, 0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(px + 4, py + 8, CELL_SIZE - 8, CELL_SIZE - 14, 7);
        ctx.stroke();
    }

    const drewChefSkin = SkinStore.draw(SKIN_SOURCES.chef[chef.id], px + 2, py, CELL_SIZE - 4, CELL_SIZE - 3, 'contain');
    if (!drewChefSkin) {
        ctx.fillStyle = COLORS.chef[chef.id];
        ctx.beginPath();
        ctx.roundRect(px + 5, py + 10, CELL_SIZE - 10, CELL_SIZE - 16, 7);
        ctx.fill();

        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(px + 11, py + 11, CELL_SIZE - 22, 10);

        ctx.fillStyle = '#fff';
        ctx.fillRect(px + 12, py + 4, CELL_SIZE - 24, 10);
        ctx.fillRect(px + 10, py + 10, CELL_SIZE - 20, 4);

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 17px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((chef.id + 1).toString(), cx, cy + 3);
    }

    if (chef.holding) {
        const bx = px + CELL_SIZE - 4;
        const by = py + CELL_SIZE + 2;
        const r = 7;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        if (chef.holding.type === 'plate') {
            const dishName = matchPlateToDish(chef.holding.items);
            const drewDish = dishName && drawDishIcon(dishName, bx - 11, by - 11, 22, 22);
            if (!drewDish) {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(bx, by, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                if (chef.holding.items && chef.holding.items.length === 1) {
                    drawIngredientIconCircle(chef.holding.items[0].ingredient, bx, by, 5);
                } else {
                    ctx.fillStyle = '#263238';
                    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(chef.holding.items.length), bx, by);
                }
            }
        } else {
            drawIngredientIconCircle(chef.holding.ingredient, bx, by, r);
            ctx.font = 'bold 8px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (chef.holding.state === INGREDIENT_STATES.CHOPPED) {
                ctx.fillStyle = '#2e7d32';
                ctx.fillText('✓', bx + 5, by - 5);
            } else if (chef.holding.state === INGREDIENT_STATES.COOKED) {
                ctx.fillStyle = '#e65100';
                ctx.fillText('✓', bx + 5, by - 5);
            } else if (chef.holding.state === INGREDIENT_STATES.BURNT) {
                ctx.fillStyle = '#c62828';
                ctx.fillText('✗', bx + 5, by - 5);
            }
        }
    }

    if (chef.path.length > 0 && (nx !== 0 || ny !== 0)) {
        const tipX = cx + nx * 17;
        const tipY = cy + ny * 17;
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.moveTo(tipX + nx * 7, tipY + ny * 7);
        ctx.lineTo(tipX - nx * 4 - ny * 5, tipY - ny * 4 + nx * 5);
        ctx.lineTo(tipX - nx * 4 + ny * 5, tipY - ny * 4 - nx * 5);
        ctx.closePath();
        ctx.fill();
    }

    if (chef.busy) {
        ctx.fillStyle = '#ffeb3b';
        ctx.font = '16px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SPD', cx, py + 6);
    }

    if (GameState.selectedChef === chef.id) {
        const pulse = 2.5 + Math.sin(Date.now() / 200) * 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = pulse;
        ctx.setLineDash([]);
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        if (Math.floor(Date.now() / 120) % 2 === 0) {
            ctx.save();
            ctx.shadowColor = 'rgba(255,255,255,0.65)';
            ctx.shadowBlur = 16;
            ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
            ctx.restore();
        }
    }
}

function drawLabels() {
    const h = MAP_HEIGHT * CELL_SIZE;
    const bannerH = 28;
    const y0 = h - bannerH;

    // Kitchen zone
    const kitchenW = 13 * CELL_SIZE;
    const grad1 = ctx.createLinearGradient(0, y0, 0, h);
    grad1.addColorStop(0, 'rgba(68,217,184,0.10)');
    grad1.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = grad1;
    ctx.fillRect(0, y0, kitchenW, bannerH);

    // Teal accent line top
    ctx.fillStyle = 'rgba(68,217,184,0.55)';
    ctx.fillRect(0, y0, kitchenW, 2);

    // Service zone
    const svcX = 14 * CELL_SIZE;
    const svcW = 6 * CELL_SIZE;
    const grad2 = ctx.createLinearGradient(0, y0, 0, h);
    grad2.addColorStop(0, 'rgba(162,89,255,0.12)');
    grad2.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = grad2;
    ctx.fillRect(svcX, y0, svcW, bannerH);

    ctx.fillStyle = 'rgba(162,89,255,0.55)';
    ctx.fillRect(svcX, y0, svcW, 2);

    // Labels
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const midY = y0 + bannerH / 2 + 1;

    ctx.fillStyle = 'rgba(68,217,184,0.95)';
    ctx.fillText('K I T C H E N', kitchenW / 2, midY);

    ctx.fillStyle = 'rgba(200,160,255,0.95)';
    ctx.fillText('S E R V I C E', svcX + svcW / 2, midY);
}

// =============================================
// UI UPDATES
// =============================================
let lastDisplayedStreak = 0;
const LEADERBOARD_KEY = 'chefOverflowLeaderboardV1';

// Supabase client, credentials defined in game.html before this script loads.
// Used only for SELECTs (leaderboard table is read-only to anon). All writes go through Edge Functions.
const _db = (typeof window.supabase !== 'undefined' && typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL !== 'https://YOUR_PROJECT.supabase.co')
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const _fnBase = (typeof SUPABASE_URL !== 'undefined' && SUPABASE_URL !== 'https://YOUR_PROJECT.supabase.co')
    ? `${SUPABASE_URL}/functions/v1`
    : null;

const HT6_API_URL = 'https://v2.api.hackthe6ix.com';
const PENDING_RUN_KEY = 'chefOverflowPendingRun';
let _ht6User = null;
let _restoredRun = null;

async function ht6CheckAuth() {
    try {
        const res = await fetch(`${HT6_API_URL}/api/auth/check`, {
            credentials: 'include',
            headers: { 'accept': 'application/json' },
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => ({}));
        const payload = data?.data ?? data;
        const user = payload?.user || payload;
        if (!user || !user.email) return null;
        return user;
    } catch (_) {
        return null;
    }
}

function ht6LoginUrl() {
    const u = new URL(`${HT6_API_URL}/api/auth/login`);
    u.searchParams.set('redirectUrl', window.location.href);
    return u.toString();
}

function ht6UserDisplayName(user) {
    if (!user) return '';
    return [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
}

function applySignedInUI() {
    const signinCard = document.getElementById('auth-signin-card');
    const identityCard = document.getElementById('auth-identity-card');
    const submitBtn = document.getElementById('submit-score-btn');
    const nameEl = document.getElementById('auth-identity-name');
    const emailEl = document.getElementById('auth-identity-email');

    if (signinCard) signinCard.hidden = true;
    if (identityCard) identityCard.hidden = false;
    if (submitBtn) submitBtn.hidden = false;
    if (nameEl) nameEl.textContent = ht6UserDisplayName(_ht6User) || '—';
    if (emailEl) emailEl.textContent = _ht6User.email;
}

function applySignedOutUI() {
    const signinCard = document.getElementById('auth-signin-card');
    const identityCard = document.getElementById('auth-identity-card');
    const submitBtn = document.getElementById('submit-score-btn');
    if (signinCard) signinCard.hidden = false;
    if (identityCard) identityCard.hidden = true;
    if (submitBtn) submitBtn.hidden = true;
}

function persistPendingRunForAuth() {
    if (!_runToken || !GameState.gameOver) return;
    try {
        sessionStorage.setItem(PENDING_RUN_KEY, JSON.stringify({
            runToken: _runToken,
            stats: {
                score: GameState.score,
                bestStreak: GameState.bestStreak,
                time: GameState.time,
                ordersDelivered: GameState.ordersDelivered,
                failedOrders: GameState.failedOrders,
                difficulty: GameState.difficulty,
            },
            receipt: (() => { try { return ScoreGuard.receipt(); } catch (_) { return null; } })(),
            verified: (() => { try { return ScoreGuard.verifyFinal(); } catch (_) { return false; } })(),
            savedAt: Date.now(),
        }));
    } catch (_) {}
}

function restorePendingRunIfAny() {
    let saved;
    try {
        const raw = sessionStorage.getItem(PENDING_RUN_KEY);
        if (!raw) return false;
        saved = JSON.parse(raw);
        sessionStorage.removeItem(PENDING_RUN_KEY);
    } catch (_) {
        return false;
    }
    if (!saved || !saved.runToken) return false;

    _runToken = saved.runToken;
    _restoredRun = saved;
    GameState.gameOver = true;
    GameState.score = saved.stats.score;
    GameState.bestStreak = saved.stats.bestStreak;
    GameState.time = saved.stats.time;
    GameState.ordersDelivered = saved.stats.ordersDelivered;
    GameState.failedOrders = saved.stats.failedOrders;
    GameState.difficulty = saved.stats.difficulty;

    document.getElementById('final-score').textContent = Math.floor(saved.stats.score);
    document.getElementById('best-streak').textContent = saved.stats.bestStreak;
    const gradeEl = document.getElementById('final-grade');
    if (gradeEl) {
        const g = gradeFromScore(saved.stats.score);
        gradeEl.textContent = g.letter;
        gradeEl.className = 'grade-letter ' + g.cls;
    }
    const ft = document.getElementById('final-time');
    if (ft) ft.textContent = formatTime(saved.stats.time);
    const fd = document.getElementById('final-delivered');
    if (fd) fd.textContent = String(saved.stats.ordersDelivered);
    const ff = document.getElementById('final-failed');
    if (ff) ff.textContent = String(saved.stats.failedOrders);
    const fdiff = document.getElementById('final-difficulty');
    if (fdiff) fdiff.textContent = saved.stats.difficulty.toFixed(1);
    const receipt = document.getElementById('run-receipt');
    if (receipt) receipt.textContent = saved.receipt ? `Run proof: ${saved.receipt}` : '';
    document.getElementById('game-over').classList.remove('hidden');
    return true;
}

async function initHt6Auth() {
    const loginBtn = document.getElementById('ht6-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            persistPendingRunForAuth();
            window.location.href = ht6LoginUrl();
        });
    }

    _ht6User = await ht6CheckAuth();
    if (_ht6User) {
        applySignedInUI();
    } else {
        applySignedOutUI();
    }
}

let _runToken = null; // { run_id, token } issued by start-run

async function startRun() {
    _runToken = null;
    if (!_fnBase) return;
    try {
        const res = await fetch(`${_fnBase}/start-run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
        });
        if (!res.ok) {
            setLeaderboardOffline(true);
            return;
        }
        const data = await res.json();
        if (data && data.run_id && data.token) {
            _runToken = { run_id: data.run_id, token: data.token };
            setLeaderboardOffline(false);
        } else {
            setLeaderboardOffline(true);
        }
    } catch (e) {
        setLeaderboardOffline(true);
    }
}

function setLeaderboardOffline(isOffline) {
    const banner = document.getElementById('leaderboard-offline-banner');
    if (banner) banner.style.display = isOffline ? '' : 'none';
}

function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain) return email;
    return local.slice(0, 1) + '***@' + domain;
}

function loadLeaderboard() {
    try {
        const raw = localStorage.getItem(LEADERBOARD_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveLeaderboard(entries) {
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(entries.slice(0, 10)));
}

async function fetchTopScores() {
    if (!_db) return null;
    try {
        const { data, error } = await _db
            .from('leaderboard')
            .select('score')
            .order('score', { ascending: false })
            .limit(10);
        return error ? null : data;
    } catch (e) {
        return null;
    }
}

function lbRowHTML(score, i) {
    const rankClass = i < 3 ? ` lb-rank-${i + 1}` : '';
    return `<div class="lb-score-row${rankClass}">` +
        `<span class="lb-medal">${i + 1}</span>` +
        `<span class="lb-score-num">${score.toLocaleString()}</span>` +
        `</div>`;
}

async function renderSideLeaderboard() {
    const mount = document.getElementById('side-lb-list');
    if (!mount) return;
    const scores = await fetchTopScores();
    if (!scores || scores.length === 0) {
        mount.innerHTML = '<div class="orders-empty">No scores yet.</div>';
        return;
    }
    mount.innerHTML = scores.map((e, i) => lbRowHTML(e.score, i)).join('');
}

async function fetchGlobalLeaderboard() {
    if (!_db) return null;
    try {
        const { data, error } = await _db
            .from('leaderboard')
            .select('email, score, grade, streak, delivered')
            .order('score', { ascending: false })
            .limit(10);
        return error ? null : data;
    } catch (e) {
        return null;
    }
}

async function renderLeaderboard() {
    const mount = document.getElementById('leaderboard-list');
    if (!mount) return;

    const global = await fetchGlobalLeaderboard();
    if (global && global.length > 0) {
        mount.innerHTML = global.map((e, i) => lbRowHTML(e.score, i)).join('');
        return;
    }

    const entries = loadLeaderboard();
    if (entries.length === 0) {
        mount.innerHTML = '<div class="orders-empty">No verified runs yet.</div>';
        return;
    }
    mount.innerHTML = entries.map((e, i) => lbRowHTML(e.score, i)).join('');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function submitVerifiedScore() {
    const submitBtn = document.getElementById('submit-score-btn');
    if (submitBtn && submitBtn.disabled) return;
    if (submitBtn) submitBtn.disabled = true;
    try {
        await _submitVerifiedScoreImpl();
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function _submitVerifiedScoreImpl() {
    const statusEl = document.getElementById('leaderboard-status');
    if (!statusEl) return;
    if (!GameState.gameOver) {
        statusEl.textContent = 'Finish the run before submitting.';
        return;
    }
    const guardOk = (() => { try { return ScoreGuard.verifyFinal(); } catch (_) { return false; } })();
    if (!guardOk && !_restoredRun?.verified) {
        statusEl.textContent = 'Run rejected: score integrity check failed.';
        return;
    }
    if (!_ht6User?.email) {
        statusEl.textContent = 'Sign in with Hack the 6ix to submit.';
        return;
    }
    const email = _ht6User.email.trim();
    if (!EMAIL_RE.test(email)) {
        statusEl.textContent = 'Authenticated email is invalid — contact HT6 organizers.';
        return;
    }

    const entry = {
        email,
        score: Math.floor(GameState.score),
        grade: gradeFromScore(GameState.score).letter,
        streak: GameState.bestStreak,
        delivered: GameState.ordersDelivered,
        time_secs: Math.floor(GameState.time),
    };

    // Always save locally as fallback (private to this browser, doesn't affect global board).
    const local = loadLeaderboard();
    local.push({ ...entry, handle: email, time: entry.time_secs, at: Date.now() });
    local.sort((a, b) => b.score - a.score);
    saveLeaderboard(local);

    if (!_fnBase) {
        statusEl.textContent = 'Saved locally (Supabase not configured).';
        await renderLeaderboard();
        return;
    }
    if (!_runToken) {
        statusEl.textContent = 'No run token — refresh and play a fresh game before submitting.';
        await renderLeaderboard();
        return;
    }

    statusEl.textContent = 'Submitting…';
    try {
        const res = await fetch(`${_fnBase}/submit-score`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({
                run_id: _runToken.run_id,
                token: _runToken.token,
                ...entry,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const reason = data?.error || `http_${res.status}`;
            const msg = ({
                rate_limited: 'Please wait a bit before submitting again.',
                implausible_score: 'Run rejected: score outside plausible range.',
                implausible_delivered: 'Run rejected: delivery count not plausible.',
                implausible_streak: 'Run rejected: streak not plausible.',
                token_used: 'This run has already been submitted.',
                token_expired: 'Run expired — start a new game to submit.',
                too_fast: 'Run too short to submit.',
                unknown_token: 'Run not recognized — start a new game.',
                bad_signature: 'Run token invalid.',
                bad_email: 'Please enter a valid email address.',
            })[reason] || 'Submission rejected.';
            statusEl.textContent = msg;
        } else if (data?.kept_existing) {
            statusEl.textContent = `Submitted — your previous best (${data.best.toLocaleString()}) still stands.`;
            // Token is one-shot; clear it.
            _runToken = null;
            renderSideLeaderboard();
        } else {
            statusEl.textContent = 'Score submitted to global leaderboard!';
            _runToken = null;
            renderSideLeaderboard();
        }
    } catch (e) {
        statusEl.textContent = 'Network error — saved locally, please try again.';
    }

    await renderLeaderboard();
}

function updateUI() {
    document.getElementById('score').textContent = Math.floor(GameState.score);
    document.getElementById('time').textContent = formatTime(GameState.time);

    const apiPhase = getApiPhase(GameState.time);
    const phaseLabels = {
        tutorial: 'Tutorial',
        ramp: 'Ramp',
        automation: 'Automation Required',
        endurance: 'Endurance'
    };
    const phaseEl = document.getElementById('phase');
    if (phaseEl) {
        phaseEl.textContent = phaseLabels[apiPhase];
        phaseEl.className = 'phase-value phase-' + apiPhase;
    }

    document.getElementById('difficulty').textContent =
        `${GameState.difficulty.toFixed(1)}x · ${phaseLabels[apiPhase]} | FAIL ${GameState.failedOrders}/${GameState.maxFailedOrders}`;

    const endBanner = document.getElementById('endurance-banner');
    if (endBanner) {
        endBanner.classList.toggle('visible', GameState.time >= 600);
    }

    const statDel = document.getElementById('stat-delivered');
    if (statDel) {
        statDel.textContent = String(GameState.ordersDelivered);
        const sf = document.getElementById('stat-failed');
        if (sf) sf.textContent = String(GameState.failedOrders);
        const sa = document.getElementById('stat-active');
        if (sa) sa.textContent = String(orders.length);
    } else {
        const ordersStats = document.getElementById('orders-stats');
        if (ordersStats && !document.getElementById('stat-delivered')) {
            const total = GameState.ordersDelivered + GameState.failedOrders + orders.length;
            ordersStats.textContent =
                `Total orders: ${total} (${GameState.ordersDelivered} delivered · ${GameState.failedOrders} failed · ${orders.length} active)`;
        }
    }

    const multVal = (1 + Math.min(1.0, GameState.streak * 0.05)).toFixed(2);
    const streakMultEl = document.getElementById('streak-mult');
    const streakNumEl = document.getElementById('streak');
    if (streakMultEl) {
        streakNumEl.textContent = String(GameState.streak);
        streakMultEl.textContent = GameState.streak > 0 ? `×${multVal}` : '';
    } else {
        streakNumEl.textContent = `${GameState.streak} (x${multVal})`;
    }

    if (GameState.streak > lastDisplayedStreak) {
        const row = document.getElementById('streak-display');
        if (row) {
            row.classList.add('streak-bump');
            setTimeout(() => row.classList.remove('streak-bump'), 450);
        }
    }
    lastDisplayedStreak = GameState.streak;

    const rushDisplay = document.getElementById('rush');
    const rushPill = document.getElementById('rush-display');
    rushDisplay.textContent = GameState.rush.active ? `LIVE ${Math.ceil(GameState.rush.timeLeft)}s` : `Idle ${Math.ceil(GameState.rush.cooldown)}s`;
    if (GameState.rush.active) {
        rushPill.classList.add('hot');
    } else {
        rushPill.classList.remove('hot');
    }

    if (GameState.selectedChef !== null) {
        const chef = chefs[GameState.selectedChef];
        document.getElementById('chef-info').textContent = `Chef ${chef.id + 1} (${chef.name})`;

        if (chef.holding) {
            if (chef.holding.type === 'plate') {
                const items = chef.holding.items.map(i => i.ingredient).join(', ');
                document.getElementById('item-info').textContent = `PLATE ${items}`;
            } else {
                const stateLabel = {
                    raw: 'RAW',
                    chopped: 'CHOP',
                    cooked: 'COOK',
                    burnt: 'BURN'
                };
                document.getElementById('item-info').textContent =
                    `${stateLabel[chef.holding.state]} ${chef.holding.state} ${chef.holding.ingredient}`;
            }
        } else {
            document.getElementById('item-info').textContent = 'Empty hands';
        }

        if (chef.boostActive) {
            document.getElementById('boost-info').textContent = `Active ${Math.ceil(chef.boostTime)}s`;
        } else if (chef.boostCooldown > 0) {
            document.getElementById('boost-info').textContent = `CD ${Math.ceil(chef.boostCooldown)}s`;
        } else {
            document.getElementById('boost-info').textContent = 'Ready';
        }
    } else {
        document.getElementById('chef-info').textContent = 'Click a chef to select';
        document.getElementById('item-info').textContent = '-';
        document.getElementById('boost-info').textContent = '-';
    }

    const chefChrome = document.querySelector('.ui-chef-compact');
    if (chefChrome) {
        chefChrome.classList.toggle('chef-selected', GameState.selectedChef !== null);
    }

    const ordersList = document.getElementById('orders-list');
    ordersList.innerHTML = '';

    if (orders.length === 0) {
        ordersList.innerHTML = '<div class="orders-empty">No orders yet…</div>';
    }

    for (const order of orders) {
        const card = document.createElement('div');
        const urgency = order.timeLeft / order.maxTime;
        const urgent = order.timeLeft < order.maxTime * 0.25;
        card.className = 'order-card' + (urgent ? ' urgent' : '') + (order.vip ? ' vip' : '');

        const top = document.createElement('div');
        top.className = 'order-card-top';
        const titleWrap = document.createElement('div');
        titleWrap.className = 'order-title-wrap';
        const emojiSpan = document.createElement('span');
        emojiSpan.className = 'order-emoji';
        const orderSkinPath = SKIN_SOURCES.order[order.dish];
        if (orderSkinPath) {
            emojiSpan.classList.add('order-emoji-img');
            const img = document.createElement('img');
            img.src = orderSkinPath;
            img.alt = order.dish;
            img.onerror = () => {
                emojiSpan.classList.remove('order-emoji-img');
                emojiSpan.textContent = order.icon || RECIPE_ICON_BY_NAME[order.dish] || 'ORD';
            };
            emojiSpan.appendChild(img);
        } else {
            emojiSpan.textContent = order.icon || RECIPE_ICON_BY_NAME[order.dish] || 'ORD';
        }
        const nameSpan = document.createElement('span');
        nameSpan.className = 'order-name';
        nameSpan.textContent = order.dish + (order.vip ? ' ' : '');
        titleWrap.appendChild(emojiSpan);
        titleWrap.appendChild(nameSpan);
        if (order.vip) {
            const vip = document.createElement('span');
            vip.className = 'vip-star';
            vip.textContent = 'VIP';
            titleWrap.appendChild(vip);
        }
        const standBadge = document.createElement('span');
        standBadge.className = 'order-stand';
        standBadge.textContent = 'Stand ' + standNumberFromStandId(order.standId);
        top.appendChild(titleWrap);
        top.appendChild(standBadge);
        card.appendChild(top);

        const chips = document.createElement('div');
        chips.className = 'order-chips';
        for (const c of order.recipe.components) {
            const chip = document.createElement('span');
            const processed = c.state === 'chopped' || c.state === 'cooked' || c.state === 'burnt';
            chip.className = 'order-chip' + (processed ? ' chip-processed' : ' chip-raw');
            const ingSkinPath = SKIN_SOURCES.ingredient[c.ingredient];
            const stateLabel = document.createElement('span');
            stateLabel.textContent = c.state;
            if (ingSkinPath) {
                const ingImg = document.createElement('img');
                ingImg.className = 'order-chip-img';
                ingImg.src = ingSkinPath;
                ingImg.alt = c.ingredient;
                ingImg.onerror = () => {
                    ingImg.remove();
                    const em = INGREDIENT_ICONS[c.ingredient] || '•';
                    stateLabel.textContent = `${em} ${c.state}`;
                };
                chip.appendChild(ingImg);
            } else {
                const em = INGREDIENT_ICONS[c.ingredient] || '•';
                stateLabel.textContent = `${em} ${c.state}`;
            }
            chip.appendChild(stateLabel);
            chips.appendChild(chip);
        }
        card.appendChild(chips);

        const timeRow = document.createElement('div');
        timeRow.className = 'order-time-large';
        timeRow.textContent = `${Math.ceil(order.timeLeft)}s left`;
        card.appendChild(timeRow);

        const timer = document.createElement('div');
        timer.className = 'order-timer';
        const fill = document.createElement('div');
        fill.className = 'order-timer-fill' + (urgent ? ' urgent' : '');
        fill.style.width = `${urgency * 100}%`;
        let barGrad;
        if (urgency > 0.75) barGrad = 'linear-gradient(90deg, #66bb6a, #43a047)';
        else if (urgency > 0.5) barGrad = 'linear-gradient(90deg, #ffee58, #fbc02d)';
        else if (urgency > 0.25) barGrad = 'linear-gradient(90deg, #ffb74d, #f57c00)';
        else barGrad = 'linear-gradient(90deg, #ef5350, #b71c1c)';
        fill.style.background = barGrad;
        timer.appendChild(fill);
        card.appendChild(timer);

        ordersList.appendChild(card);
    }
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================
// INPUT HANDLING
// =============================================
canvas.addEventListener('click', (e) => {
    if (!GameState.running || GameState.paused) return;
    
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX / CELL_SIZE);
    const y = Math.floor((e.clientY - rect.top) * scaleY / CELL_SIZE);
    
    // Check if clicked on a chef
    const clickedChef = chefs.find(c => c.x === x && c.y === y);
    
    if (clickedChef) {
        GameState.selectedChef = clickedChef.id;
        return;
    }
    
    // If chef is selected, send them to clicked location
    if (GameState.selectedChef !== null) {
        const chef = chefs[GameState.selectedChef];
        if (chef.busy) return;
        
        // Check if clicked on a station
        const stationInfo = getStationAt(x, y);
        
        if (stationInfo) {
            const st = stationInfo.station;
            const adjacent = findAdjacentWalkable(x, y);
            if (adjacent) {
                if (isChefAdjacentToStation(chef.x, chef.y, st.x, st.y)) {
                    chef.path = [];
                    chef.targetStation = null;
                    interactWithStation(chef, stationInfo);
                } else {
                    const path = findPath(chef.x, chef.y, adjacent.x, adjacent.y);
                    if (path.length > 0) {
                        chef.path = path;
                        chef.targetStation = stationInfo;
                    }
                }
            }
        } else if (isWalkable(x, y)) {
            // Just move to floor tile
            const path = findPath(chef.x, chef.y, x, y);
            chef.path = path;
            chef.targetStation = null;
        }
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= '5') {
        GameState.selectedChef = parseInt(e.key) - 1;
    }
    if (e.key === 'Escape') {
        GameState.selectedChef = null;
    }
    if (e.key === ' ' && GameState.running) {
        togglePause();
    }
    if (e.key.toLowerCase() === 'b') {
        activateBoost();
    }
});

function tryBoostChef(chef) {
    if (!chef || chef.boostActive || chef.boostCooldown > 0) {
        return { success: false, error: 'Boost not available' };
    }
    chef.boostActive = true;
    chef.boostTime = 3.5;
    chef.boostCooldown = 12;
    showFloatingText(chef.x, chef.y, 'Speed boost!', '#ffd54f');
    return { success: true };
}

function activateBoost() {
    if (GameState.selectedChef === null) return;
    const chef = chefs[GameState.selectedChef];
    tryBoostChef(chef);
}

// =============================================
// GAME CONTROL
// =============================================
function startGame() {
    EventBus.clear();
    registerAgent();
    GameState.running = true;
    GameState.paused = false;
    GameState.gameOver = false;
    GameState.time = 0;
    GameState.score = 0;
    ScoreGuard.reset();
    startRun();
    GameState.difficulty = 1.0;
    GameState.streak = 0;
    GameState.bestStreak = 0;
    GameState.failedOrders = 0;
    GameState.ordersDelivered = 0;
    GameState.selectedChef = null;
    lastDisplayedStreak = 0;
    GameState.moveTimer = 0;
    GameState.phaseBanner60 = false;
    GameState.phaseBanner150 = false;
    GameState.phaseBanner600Float = false;
    lastEmittedPhase = getApiPhase(0);
    GameState.rush.active = false;
    GameState.rush.timeLeft = 0;
    GameState.rush.cooldown = 20;
    GameState.orderSpawnDebt = 0;
    
    // Reset stations
    stations.stoves.forEach(s => { s.cooking = null; s.cookTime = 0; s.busy = false; });
    stations.cuttingBoards.forEach(s => { s.processing = null; s.processTime = 0; s.busy = false; });
    stations.platingAreas.forEach(s => { s.items = []; s.busy = false; });
    stations.receptionStands.forEach(s => { s.order = null; s.customer = null; });
    
    orders.length = 0;
    orderIdCounter = 0;
    floatingTexts.length = 0;
    
    initChefs();
    
    // Spawn initial orders
    setTimeout(() => spawnOrder(), 1000);
    setTimeout(() => spawnOrder(), 3000);
    
    document.getElementById('start-btn').disabled = true;
    document.getElementById('pause-btn').disabled = false;
    document.getElementById('game-over').classList.add('hidden');
    document.body.classList.add('game-running');

    lastTime = performance.now();
}

function togglePause() {
    GameState.paused = !GameState.paused;
    document.getElementById('pause-btn').textContent = GameState.paused ? 'Resume' : 'Pause';
}

function gradeFromScore(score) {
    const s = Math.floor(score);
    if (s < 0) return { letter: 'F', cls: 'grade-f' };
    if (s < 500) return { letter: 'D', cls: 'grade-d' };
    if (s < 2000) return { letter: 'C', cls: 'grade-c' };
    if (s < 5000) return { letter: 'B', cls: 'grade-b' };
    if (s < 10000) return { letter: 'A', cls: 'grade-a' };
    return { letter: 'S', cls: 'grade-s' };
}

function endGame() {
    GameState.running = false;
    GameState.gameOver = true;
    EventBus.emit('gameOver', {
        score: GameState.score,
        time: GameState.time,
        bestStreak: GameState.bestStreak
    });
    document.getElementById('final-score').textContent = Math.floor(GameState.score);
    document.getElementById('best-streak').textContent = GameState.bestStreak;

    const gradeEl = document.getElementById('final-grade');
    if (gradeEl) {
        const g = gradeFromScore(GameState.score);
        gradeEl.textContent = g.letter;
        gradeEl.className = 'grade-letter ' + g.cls;
    }
    const ft = document.getElementById('final-time');
    if (ft) ft.textContent = formatTime(GameState.time);
    const fd = document.getElementById('final-delivered');
    if (fd) fd.textContent = String(GameState.ordersDelivered);
    const ff = document.getElementById('final-failed');
    if (ff) ff.textContent = String(GameState.failedOrders);
    const fdiff = document.getElementById('final-difficulty');
    if (fdiff) fdiff.textContent = GameState.difficulty.toFixed(1);
    const receipt = document.getElementById('run-receipt');
    if (receipt) {
        receipt.textContent = ScoreGuard.verifyFinal()
            ? `Run proof: ${ScoreGuard.receipt()}`
            : 'Run proof: INVALID';
    }
    const status = document.getElementById('leaderboard-status');
    if (status) status.textContent = '';
    renderLeaderboard();

    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('pause-btn').disabled = true;
    document.body.classList.remove('game-running');
}

// Button listeners
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('restart-btn').addEventListener('click', startGame);
const submitScoreBtn = document.getElementById('submit-score-btn');
if (submitScoreBtn) submitScoreBtn.addEventListener('click', submitVerifiedScore);

const shareBtn = document.getElementById('share-btn');
if (shareBtn) {
    shareBtn.addEventListener('click', () => {
        const score = document.getElementById('final-score')?.textContent || '0';
        const grade = document.getElementById('final-grade')?.textContent || '?';
        const streak = document.getElementById('best-streak')?.textContent || '0';
        const text = `I scored ${score} in Chef Overflow (Grade: ${grade}, Streak: ${streak}). Can you beat me?`;
        navigator.clipboard.writeText(text).catch(() => {});
    });
}

// =============================================
// AGENT API (for programmatic control)
// =============================================
function serializeAgentInventoryItem(item) {
    if (!item) return null;
    if (item.type === 'plate') {
        return {
            type: 'plate',
            items: (item.items || []).map(i => ({ ingredient: i.ingredient, state: i.state }))
        };
    }
    return { ingredient: item.ingredient, state: item.state };
}

window.KitchenAPI = {
    version: '2.0.0',

    getState: () => ({
        time: GameState.time,
        score: GameState.score,
        difficulty: GameState.difficulty,
        streak: GameState.streak,
        bestStreak: GameState.bestStreak,
        rush: { ...GameState.rush },
        failedOrders: GameState.failedOrders,
        maxFailedOrders: GameState.maxFailedOrders,
        phase: getApiPhase(GameState.time),
        running: GameState.running,
        paused: GameState.paused,
        gameOver: GameState.gameOver,
        chefs: chefs.map(c => ({
            id: c.id,
            name: c.name,
            pos: [c.x, c.y],
            holding: c.holding,
            busy: c.busy,
            hasPath: c.path.length > 0,
            boostActive: c.boostActive,
            boostTime: c.boostTime,
            boostCooldown: c.boostCooldown
        })),
        stations: {
            ingredientBins: stations.ingredientBins.map(b => ({
                id: b.id,
                name: b.name,
                pos: [b.x, b.y],
                ingredient: b.ingredient
            })),
            stoves: stations.stoves.map(s => ({
                id: s.id,
                name: s.name,
                pos: [s.x, s.y],
                cooking: s.cooking,
                cookTime: s.cookTime,
                maxCookTime: s.maxCookTime,
                ready: s.cookTime >= s.maxCookTime * 0.8 && s.cookTime < s.maxCookTime * 1.5,
                burnt: s.cookTime >= s.maxCookTime * 1.5
            })),
            cuttingBoards: stations.cuttingBoards.map(b => ({
                id: b.id,
                name: b.name,
                pos: [b.x, b.y],
                busy: b.busy,
                processing: b.processing,
                processTime: b.processTime,
                maxProcessTime: b.maxProcessTime
            })),
            platingAreas: stations.platingAreas.map(p => ({
                id: p.id,
                name: p.name,
                pos: [p.x, p.y],
                items: p.items
            })),
            receptionStands: stations.receptionStands.map(r => ({
                id: r.id,
                name: r.name,
                pos: [r.x, r.y],
                order: r.order ? {
                    id: r.order.id,
                    dish: r.order.dish,
                    timeLeft: r.order.timeLeft,
                    components: r.order.recipe.components
                } : null
            })),
            trashCans: stations.trashCans.map(t => ({
                id: t.id,
                pos: [t.x, t.y]
            })),
            counters: stations.counters.map(c => ({
                id: c.id,
                pos: [c.x, c.y],
                items: (c.items || []).map(serializeAgentInventoryItem).filter(Boolean)
            }))
        },
        orders: orders.map(o => ({
            id: o.id,
            dish: o.dish,
            timeLeft: o.timeLeft,
            standId: o.standId,
            components: o.recipe.components
        })),
        recipes: RECIPES
    }),

    command: (chefId, targetId) => {
        if (!GameState.running || GameState.paused) return { success: false, error: 'Game not running' };

        const chef = chefs.find(c => c.id === chefId);
        if (!chef) return { success: false, error: 'Invalid chef_id' };
        if (chef.busy) return { success: false, error: 'Chef is busy' };

        let stationInfo = null;
        let targetX;
        let targetY;

        const stationTypes = {
            ingredientBins: 'ingredientBin',
            stoves: 'stove',
            cuttingBoards: 'cuttingBoard',
            platingAreas: 'platingArea',
            receptionStands: 'receptionStand',
            trashCans: 'trash',
            counters: 'counter'
        };

        for (const [arrayName, typeName] of Object.entries(stationTypes)) {
            const found = stations[arrayName].find(s => s.id === targetId);
            if (found) {
                stationInfo = { type: typeName, station: found };
                targetX = found.x;
                targetY = found.y;
                break;
            }
        }

        if (!stationInfo) return { success: false, error: 'Invalid target' };

        const adjacent = findAdjacentWalkable(targetX, targetY);
        if (!adjacent) return { success: false, error: 'Cannot reach target' };

        if (isChefAdjacentToStation(chef.x, chef.y, targetX, targetY)) {
            chef.path = [];
            chef.targetStation = null;
            interactWithStation(chef, stationInfo);
            return { success: true };
        }

        const path = findPath(chef.x, chef.y, adjacent.x, adjacent.y);
        if (path.length === 0) {
            return { success: false, error: 'No path found' };
        }

        chef.path = path;
        chef.targetStation = stationInfo;

        return { success: true };
    },

    boost: (chefId) => {
        const chef = chefs.find(c => c.id === chefId);
        return tryBoostChef(chef);
    },

    getRecipes: () =>
        Object.entries(RECIPES).map(([name, recipe]) => ({
            name,
            icon: recipe.icon || RECIPE_ICON_BY_NAME[name] || 'ORD',
            difficulty: recipe.difficulty,
            components: recipe.components.map(c => ({ ingredient: c.ingredient, state: c.state }))
        })),

    on: (event, callback) => EventBus.on(event, callback),
    onTick: callback => EventBus.on('tick', callback),
    onOrderSpawned: callback => EventBus.on('orderSpawned', callback),
    onOrderExpired: callback => EventBus.on('orderExpired', callback),
    onOrderDelivered: callback => EventBus.on('orderDelivered', callback),
    onOrderFailed: callback => EventBus.on('orderFailed', callback),
    onGameOver: callback => EventBus.on('gameOver', callback),
    onPhaseChanged: callback => EventBus.on('phaseChanged', callback),

    selectChef: (chefId) => {
        GameState.selectedChef = chefId;
    },

    run: (fn) => { _agentFn = fn; registerAgent(); },
    stop: () => { _agentFn = null; registerAgent(); },
    clearListeners: () => EventBus.clear(),

    start: startGame,

    togglePause: togglePause
};

SkinStore.init();
initChefs();
lastTime = performance.now();
requestAnimationFrame(gameLoop);
renderLeaderboard();
renderSideLeaderboard();
setInterval(renderSideLeaderboard, 30_000);
restorePendingRunIfAny();
initHt6Auth();

console.log(`
Chef Overflow v2.0
================================
API: window.KitchenAPI

Quick start:
  KitchenAPI.run(fn)                    // Register your agent: fn(state, api, tick)
  KitchenAPI.start()                    // Start game (run() agents survive restarts)
  KitchenAPI.stop()                     // Unregister your agent
  KitchenAPI.getState()                 // Full game state snapshot
  KitchenAPI.command(chefId, stationId) // Send chef to station
  KitchenAPI.boost(chefId)              // Activate speed boost
  KitchenAPI.getRecipes()               // List all recipes

Station IDs:
  bin_0..5      Ingredient bins (tomato, lettuce, onion, meat, dough, cheese)
  stove_0..2    Stoves
  cutting_0..1  Cutting boards
  plating_0..3  Plating areas (infinite — drop ingredients, pick up plate)
  trash_0       Trash
  counter_0..N  Counter tiles
  reception_0..4 Customer stands

Events:
  KitchenAPI.onOrderSpawned(fn)   // New order appeared
  KitchenAPI.onOrderExpired(fn)   // Order timed out
  KitchenAPI.onOrderDelivered(fn) // Correct delivery
  KitchenAPI.onOrderFailed(fn)    // Wrong dish at reception
  KitchenAPI.onPhaseChanged(fn)   // tutorial / ramp / automation / endurance
  KitchenAPI.onGameOver(fn)       // Game ended

Minimal steak agent (bin → stove → plating → reception):
  KitchenAPI.onTick(() => {
    const s = KitchenAPI.getState();
    if (!s.running || s.paused) return;
    const c = s.chefs[0];
    if (c.busy || c.hasPath) return;
    const steak = s.orders.find(o => o.dish === 'Steak');
    if (!steak) return;
    const h = c.holding;
    const platItems = s.stations.platingAreas[0].items || [];
    const meatReady = platItems.some(i => i.ingredient === 'meat' && i.state === 'cooked');
    if (!h) {
      KitchenAPI.command(0, meatReady ? 'plating_0' : 'bin_3');
      return;
    }
    if (h.ingredient === 'meat' && h.state === 'raw') { KitchenAPI.command(0, 'stove_0'); return; }
    if (h.ingredient === 'meat' && h.state === 'cooked') { KitchenAPI.command(0, 'plating_0'); return; }
    if (h.type === 'plate') {
      KitchenAPI.command(0, steak.standId);
    }
  });

Full docs: open docs.html
`);

// =============================================
// RECIPE DECK — scroll-driven stacked-card reveal
// =============================================
(function initRecipeDeckScroll() {
    function start() {
        const grid = document.querySelector('.recipe-grid');
        if (!grid) return;
        const cards = Array.from(grid.querySelectorAll('.recipe-card'));
        if (!cards.length) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Per-card resting pose inside the pile (rotation in deg, depth scale).
        const ROTS = [-7, 4, -3, 8, -5, 3, -6];
        const STAGGER = 0.06;          // fraction of progress each card lags behind
        const SPAN = 1 - STAGGER * (cards.length - 1);

        let deltas = [];               // {dx, dy} natural-position -> stack anchor
        let enabled = false;
        let ticking = false;

        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

        function spreadPose() {
            cards.forEach(card => {
                card.style.setProperty('--sx', '0px');
                card.style.setProperty('--sy', '0px');
                card.style.setProperty('--sr', '0deg');
                card.style.setProperty('--ss', '1');
                card.style.zIndex = '';
            });
        }

        function measure() {
            // Disable the effect on narrow viewports or with reduced motion.
            if (reduceMotion || window.innerWidth < 1100) {
                enabled = false;
                spreadPose();
                return;
            }
            enabled = true;
            // Neutralize any active collapse transform first — getBoundingClientRect
            // includes transforms, so we must read the true layout positions.
            spreadPose();
            // Anchor the pile on the first row so it sits in the upper part of the
            // panel and is visible as the section scrolls into view.
            const anchorEl = grid.querySelector('.recipe-row--4') || grid;
            const aRect = anchorEl.getBoundingClientRect();
            const anchorX = aRect.left + aRect.width / 2;
            const anchorY = aRect.top + aRect.height / 2;
            deltas = cards.map(card => {
                const r = card.getBoundingClientRect();
                return {
                    dx: anchorX - (r.left + r.width / 2),
                    dy: anchorY - (r.top + r.height / 2)
                };
            });
        }

        function apply() {
            ticking = false;
            if (!enabled) return;
            const vh = window.innerHeight;
            const gridTop = grid.getBoundingClientRect().top;
            const startAt = vh * 0.83;   // begin spreading
            const endAt = vh * 0.41;     // fully spread
            const p = clamp((startAt - gridTop) / (startAt - endAt), 0, 1);

            cards.forEach((card, i) => {
                // staggered per-card progress so cards deal out in sequence
                const pc = easeOutCubic(clamp((p - i * STAGGER) / SPAN, 0, 1));
                const collapse = 1 - pc;
                const d = deltas[i] || { dx: 0, dy: 0 };
                card.style.setProperty('--sx', (d.dx * collapse).toFixed(2) + 'px');
                card.style.setProperty('--sy', (d.dy * collapse).toFixed(2) + 'px');
                card.style.setProperty('--sr', (ROTS[i % ROTS.length] * collapse).toFixed(2) + 'deg');
                card.style.setProperty('--ss', (1 - 0.03 * collapse).toFixed(3));
                card.style.zIndex = collapse > 0.001 ? String(i + 1) : '';
            });
        }

        function onScroll() {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(apply);
        }

        function refresh() {
            measure();
            apply();
        }

        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', refresh);
        window.addEventListener('load', refresh);
        refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
