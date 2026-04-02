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
    maxFailedOrders: 5,
    moveTimer: 0,
    moveDelay: 0.18, // Slower chef movement
    rush: {
        active: false,
        timeLeft: 0,
        cooldown: 20
    },
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
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
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

let lastEmittedPhase = 'tutorial';

function getPhaseKey(time) {
    if (time < 60) return 'tutorial';
    if (time < 150) return 'ramp';
    return 'automation';
}

function getApiPhase(time) {
    if (time >= 600) return 'endurance';
    const k = getPhaseKey(time);
    if (k === 'tutorial') return 'tutorial';
    if (k === 'ramp') return 'ramp';
    return 'automation';
}

function computeDifficulty(time) {
    const phase = getPhaseKey(time);
    if (phase === 'tutorial') {
        return 1.0 + (time / 60) * 0.15;
    }
    if (phase === 'ramp') {
        return 1.15 + ((time - 60) / 90) * 0.45;
    }
    return 1.8 + (time - 150) * 0.002;
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

const INGREDIENT_BIN_EMOJI = {
    tomato: '🍅',
    lettuce: '🥬',
    onion: '🧅',
    meat: '🥩',
    dough: '🍞',
    cheese: '🧀'
};

function floorFillColor(x, y) {
    const light = (x + y) % 2 === 0;
    if (x >= 14) {
        return light ? '#252838' : '#1c2034';
    }
    return light ? '#1e2a38' : '#1c2836';
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
        dishRack: '#8d6e63',
        trash: '#37474f',
        sink: '#78909c',
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
    tomato: '🍅 Tomato',
    lettuce: '🥬 Lettuce', 
    onion: '🧅 Onion',
    meat: '🥩 Meat',
    dough: '🍞 Dough',
    cheese: '🧀 Cheese'
};

const INGREDIENT_STATES = {
    RAW: 'raw',
    CHOPPED: 'chopped',
    COOKED: 'cooked',
    BURNT: 'burnt'
};

const RECIPES = {
    'Salad': {
        emoji: '🥗',
        steps: ['chop_lettuce', 'chop_tomato'],
        components: [
            { ingredient: 'lettuce', state: 'chopped' },
            { ingredient: 'tomato', state: 'chopped' }
        ],
        difficulty: 1,
        instructions: '1. Chop Lettuce\n2. Chop Tomato\n3. Plate both'
    },
    'Burger': {
        emoji: '🍔',
        steps: ['cook_meat', 'plate_with_bun'],
        components: [
            { ingredient: 'meat', state: 'cooked' },
            { ingredient: 'dough', state: 'raw' }
        ],
        difficulty: 2,
        instructions: '1. Cook Meat on Stove\n2. Get Dough (bun)\n3. Plate both'
    },
    'Steak': {
        emoji: '🥩',
        steps: ['cook_meat'],
        components: [
            { ingredient: 'meat', state: 'cooked' }
        ],
        difficulty: 1,
        instructions: '1. Cook Meat on Stove\n2. Plate when ready'
    },
    'Pizza': {
        emoji: '🍕',
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
        emoji: '🍔✨',
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
        emoji: '🍱',
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
        emoji: '🍕✨',
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
    ramp: ['Salad', 'Steak', 'Burger'],
    automation: null
};

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
    DISH_RACK: 8,
    TRASH: 9,
    SINK: 10,
    RECEPTION_STAND: 7
};

// Station definitions with positions
const stations = {
    ingredientBins: [],
    stoves: [],
    cuttingBoards: [],
    platingAreas: [],
    counters: [],
    dishRacks: [],
    trashCans: [],
    sinks: [],
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

// Place plating areas (2) - near pass-through
const platingPositions = [
    { x: 10, y: 5 }, { x: 10, y: 8 }
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

// Place a dishes rack (limited plates)
const dishRackPos = { x: 11, y: 5 };
map[dishRackPos.y][dishRackPos.x] = TILE_TYPES.DISH_RACK;
stations.dishRacks.push({ id: 'dishrack_0', x: dishRackPos.x, y: dishRackPos.y, count: 5, maxCount: 8, dirty: 0 });

// Place a sink
const sinkPos = { x: 3, y: 5 };
map[sinkPos.y][sinkPos.x] = TILE_TYPES.SINK;
stations.sinks.push({ id: 'sink_0', x: sinkPos.x, y: sinkPos.y });

// Place a trash can
const trashPos = { x: 3, y: 9 };
map[trashPos.y][trashPos.x] = TILE_TYPES.TRASH;
stations.trashCans.push({ id: 'trash_0', x: trashPos.x, y: trashPos.y });

// 5 stools for customers
const receptionPositions = [
    { x: 17, y: 2 }, { x: 17, y: 5 }, { x: 17, y: 8 }, { x: 17, y: 11 }, { x: 17, y: 13 }
];
receptionPositions.forEach((pos, i) => {
    map[pos.y][pos.x] = TILE_TYPES.RECEPTION_STAND;
    stations.receptionStands.push({
        id: `reception_${i}`,
        name: `Counter ${i + 1}`,
        x: pos.x,
        y: pos.y,
        order: null,
        customer: null, // { timeLeft }
        hasDirtyDish: false
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
            holding: null,
            busy: false,
            actionTimer: 0,
            moveTimer: 0,
            waitingAt: null,
            waitingAtStove: null,
            waitingAtSink: null,
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
    return !s.order && !s.customer && !s.hasDirtyDish;
}

function failOrderNoStandSlot() {
    GameState.failedOrders++;
    GameState.score -= 50;
    GameState.streak = 0;
    showFloatingText(10, 7, 'No room! Order lost!', '#f44336', { fontSize: 22, life: 3, maxLife: 3, drift: 0 });
}

function spawnOrder() {
    const phase = getPhaseKey(GameState.time);
    const availableStands = stations.receptionStands.filter(standFreeForOrder);

    if (availableStands.length === 0) {
        if (phase === 'automation') {
            failOrderNoStandSlot();
        }
        return;
    }

    const stand = availableStands[Math.floor(Math.random() * availableStands.length)];

    const names = RECIPE_NAMES_BY_PHASE[phase];
    const recipeEntries = names
        ? names.map(name => [name, RECIPES[name]])
        : Object.entries(RECIPES);
    const [dishName, recipe] = recipeEntries[Math.floor(Math.random() * recipeEntries.length)];

    let timeLimit;
    if (phase === 'tutorial') {
        timeLimit = 62 + Math.floor(Math.random() * 7);
    } else if (phase === 'ramp') {
        timeLimit = 44 + Math.floor(Math.random() * 5);
    } else {
        timeLimit = 30 + Math.floor(Math.random() * 6);
    }

    const vip = Math.random() < 0.12;

    const order = {
        id: orderIdCounter++,
        dish: dishName,
        emoji: recipe.emoji,
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
}

// =============================================
// PATHFINDING (A*)
// =============================================
function findPath(startX, startY, endX, endY) {
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
        
        const neighbors = getNeighbors(current.x, current.y);
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

function getNeighbors(x, y) {
    const neighbors = [];
    const directions = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    
    for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        
        if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT) {
            if (isWalkable(nx, ny)) {
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
    for (const rack of stations.dishRacks) {
        if (rack.x === x && rack.y === y) return { type: 'dishRack', station: rack };
    }
    for (const trash of stations.trashCans) {
        if (trash.x === x && trash.y === y) return { type: 'trash', station: trash };
    }
    for (const sink of stations.sinks) {
        if (sink.x === x && sink.y === y) return { type: 'sink', station: sink };
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
                        showFloatingText(station.x, station.y, `🍽️ Combined on plate: ${plateSummary(chef.holding)}`, '#4caf50');
                        return;
                    }

                    // Otherwise full / incompatible
                    showFloatingText(station.x, station.y, 'Counter is full — remove the item first', '#ffb74d');
                    return;
                }

                // Empty counter: place item
                station.items.push(chef.holding);
                if (chef.holding.type === 'plate') {
                    showFloatingText(station.x, station.y, `🍽️ Plate placed: ${plateSummary(chef.holding)}`, '#ffd54f');
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

        case 'dishRack':
            // Take an empty plate or return an empty plate
            if (!chef.holding) {
                if (station.count > 0) {
                    chef.holding = { type: 'plate', items: [], dirty: false };
                    station.count -= 1;
                    showFloatingText(chef.x, chef.y, 'Picked up clean plate 🍽️', '#fff');
                } else if (station.dirty && station.dirty > 0) {
                    // Pick up a dirty plate from the rack to bring to sink
                    chef.holding = { type: 'plate', items: [], dirty: true };
                    station.dirty -= 1;
                    showFloatingText(chef.x, chef.y, 'Picked up dirty plate 🟤', '#ffcc80');
                } else {
                    if (countCleanPlatesInWorld() === 0) {
                        showFloatingText(station.x, station.y, 'No clean plates!', '#ffb74d');
                    } else {
                        showFloatingText(station.x, station.y, 'No clean plates here — check the line', '#ffb74d');
                    }
                }
            } else if (chef.holding && chef.holding.type === 'plate') {
                // Returning plates: if empty -> add to clean count (respect max), if dirty -> add to dirty pile
                if (!chef.holding.items || chef.holding.items.length === 0) {
                    if (chef.holding.dirty) {
                        station.dirty = station.dirty || 0;
                        station.dirty += 1;
                        chef.holding = null;
                        showFloatingText(station.x, station.y, 'Returned dirty plate — it will be washed', '#ff7043');
                    } else if (station.count < (station.maxCount || 8)) {
                        station.count += 1;
                        chef.holding = null;
                        showFloatingText(station.x, station.y, 'Returned plate to rack', '#ffd54f');
                    } else {
                        showFloatingText(station.x, station.y, 'Dish rack full — cannot return plate', '#ffb74d');
                    }
                } else {
                    showFloatingText(station.x, station.y, 'Clear the plate before returning it', '#ffb74d');
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
                showFloatingText(station.x, station.y, '🔪 Chopping...', '#fff');
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
                    
                    const msg = chef.holding.state === INGREDIENT_STATES.BURNT ? '💨 Burnt!' : '✓ Cooked!';
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
                showFloatingText(station.x, station.y, '🔥 Cooking...', '#ff9800');
            }
            break;

        case 'sink':
            // Wash a dirty plate while holding it
            if (chef.holding && chef.holding.type === 'plate') {
                if ((chef.holding.items && chef.holding.items.length > 0) || chef.holding.dirty) {
                    // Start washing: short delay, then clear items
                    chef.busy = true;
                    chef.actionTimer = 2.0; // 2 seconds to wash
                    chef.waitingAtSink = station;
                    showFloatingText(station.x, station.y, '🧼 Washing plate...', '#4fc3f7');
                } else {
                    showFloatingText(station.x, station.y, 'Plate is already clean', '#9e9e9e');
                }
            } else {
                showFloatingText(station.x, station.y, 'Hold a dirty plate to wash it', '#9e9e9e');
            }
            break;
            
        case 'platingArea':
            // Add item to plate or pick up plate. Allow combining into a held plate.
            if (chef.holding && chef.holding.type !== 'plate') {
                // Restriction: no serving raw meat directly to plating
                if (chef.holding.ingredient === 'meat' && chef.holding.state === INGREDIENT_STATES.RAW) {
                    showFloatingText(station.x, station.y, 'No serving raw meat! 🔥 Cook it first.', '#ffb74d');
                    return;
                }
                // If plating area already has a plate, add ingredient to that plate
                if (station.items.length === 1 && station.items[0].type === 'plate') {
                    station.items[0].items.push(chef.holding);
                    showFloatingText(station.x, station.y, `Added ${chef.holding.ingredient} to plate: ${plateSummary(station.items[0])}`, '#4caf50');
                    chef.holding = null;
                } else {
                    station.items.push(chef.holding);
                    showFloatingText(station.x, station.y, `+1 (${station.items.length} items)`, '#2196f3');
                    chef.holding = null;
                }

            } else if (chef.holding && chef.holding.type === 'plate') {
                if (chef.holding.dirty) {
                    showFloatingText(station.x, station.y, 'Dirty plate — wash it first', '#ffb74d');
                    return;
                }
                // If holding a plate and there are items on the plating area, combine them onto the plate
                if (station.items && station.items.length > 0) {
                    // If the plating area already has a plate, disallow stacking plates
                    if (station.items.length === 1 && station.items[0].type === 'plate') {
                        showFloatingText(station.x, station.y, 'Cannot stack plates here — pick up the existing plate first', '#ffb74d');
                    } else {
                        chef.holding.items = chef.holding.items.concat(station.items);
                        station.items = [];
                        showFloatingText(station.x, station.y, `🍽️ Combined: ${plateSummary(chef.holding)}`, '#4caf50');
                    }
                } else {
                    // Empty plating area: place plate as an item
                    station.items.push(chef.holding);
                    showFloatingText(station.x, station.y, `🍽️ Plate placed: ${plateSummary(chef.holding)}`, '#ffd54f');
                    chef.holding = null;
                }

            } else if (!chef.holding && station.items.length > 0) {
                // Pick up as plated dish or pick up a plate item
                const top = station.items[station.items.length - 1];
                if (top.type === 'plate') {
                    chef.holding = station.items.pop();
                    showFloatingText(chef.x, chef.y, `Picked up plate: ${plateSummary(chef.holding)}`, '#2196f3');
                } else {
                    // If there are raw ingredients on the plating area, picking them up yields a plate with those items
                    chef.holding = { type: 'plate', items: [...station.items] };
                    station.items = [];
                    showFloatingText(chef.x, chef.y, `🍽️ Plate ready: ${plateSummary(chef.holding)}`, '#2196f3');
                }
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
                    GameState.score += totalScore;
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
                    station.hasDirtyDish = false;

                    EventBus.emit('orderDelivered', {
                        id: deliveredOrder.id,
                        dish: deliveredOrder.dish,
                        score: totalScore,
                        streak: GameState.streak
                    });
                } else {
                    EventBus.emit('orderFailed', { dish: station.order.dish });
                    showFloatingText(station.x, station.y, '❌ Wrong dish!', '#f44336', { kind: 'error' });
                    GameState.streak = 0;
                }
                chef.holding = null;
            } else if (!chef.holding && station.hasDirtyDish) {
                // Pick up dirty dish left by customer
                chef.holding = { type: 'plate', items: [], dirty: true };
                station.hasDirtyDish = false;
                showFloatingText(chef.x, chef.y, 'Picked dirty dish', '#9e9e9e');
            }
            break;

        case 'trash':
            if (chef.holding) {
                chef.holding = null;
                showFloatingText(chef.x, chef.y, '🗑️ Trashed', '#9e9e9e');
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

function countCleanPlatesInWorld() {
    let n = 0;
    for (const rack of stations.dishRacks) {
        n += rack.count || 0;
    }
    for (const p of stations.platingAreas) {
        if (!p.items || p.items.length !== 1) continue;
        const top = p.items[0];
        if (top.type === 'plate' && !top.dirty && (!top.items || top.items.length === 0)) n++;
    }
    for (const c of stations.counters) {
        if (!c.items || c.items.length === 0) continue;
        const top = c.items[c.items.length - 1];
        if (top.type === 'plate' && !top.dirty && (!top.items || top.items.length === 0)) n++;
    }
    for (const ch of chefs) {
        if (ch.holding && ch.holding.type === 'plate' && !ch.holding.dirty &&
            (!ch.holding.items || ch.holding.items.length === 0)) {
            n++;
        }
    }
    return n;
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
    const fontFamily = 'system-ui, "Segoe UI", sans-serif';
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
        if (ft.kind === 'error' || (ft.text.includes('❌') && ft.color === '#f44336')) {
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
    if (!GameState.running) return;
    
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;
    
    if (!GameState.paused) {
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
        showFloatingText(10, 7, '⚠️ PICKING UP THE PACE!', '#ffeb3b', { fontSize: 28, life: 3, maxLife: 3, drift: 0, kind: 'phase' });
    }
    if (!GameState.phaseBanner150 && GameState.time >= 150) {
        GameState.phaseBanner150 = true;
        showFloatingText(10, 7, '🤖 CAN YOU KEEP UP?', '#f44336', { fontSize: 28, life: 3, maxLife: 3, drift: 0, kind: 'phase' });
    }
    if (!GameState.phaseBanner600Float && GameState.time >= 600) {
        GameState.phaseBanner600Float = true;
        showFloatingText(10, 7, '🏆 ENDURANCE MODE', '#ffc107', { fontSize: 28, life: 4, maxLife: 4, drift: 0, kind: 'phase' });
    }

    if (GameState.time >= 600) {
        GameState.score += dt * GameState.difficulty;
    }

    const phase = getPhaseKey(GameState.time);

    if (GameState.rush.active) {
        GameState.rush.timeLeft -= dt;
        if (GameState.rush.timeLeft <= 0) {
            GameState.rush.active = false;
            GameState.rush.cooldown = phase === 'automation'
                ? 15 + Math.random() * 5
                : 30 + Math.random() * 25;
        }
    } else {
        GameState.rush.cooldown -= dt;
        if (GameState.rush.cooldown <= 0) {
            GameState.rush.active = true;
            GameState.rush.timeLeft = phase === 'automation'
                ? 12 + Math.random() * 8
                : 10 + Math.random() * 6;
            showFloatingText(12, 2, 'RUSH HOUR!', '#ffd54f');
        }
    }

    let orderInterval;
    if (phase === 'tutorial') {
        orderInterval = GameState.rush.active ? 8 + Math.random() * 4 : 15 + Math.random() * 5;
    } else if (phase === 'ramp') {
        orderInterval = GameState.rush.active ? 6 + Math.random() * 3 : 10 + Math.random() * 2;
    } else {
        orderInterval = GameState.rush.active ? 3 + Math.random() : 5 + Math.random() * 2;
    }
    if (Math.random() < dt / orderInterval) {
        spawnOrder();
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
            // Finish washing at sink
            if (chef.waitingAtSink) {
                if (chef.holding && chef.holding.type === 'plate') {
                    chef.holding.items = [];
                    chef.holding.dirty = false;
                    showFloatingText(chef.x, chef.y, '✨ Plate cleaned!', '#4fc3f7');
                }
                chef.waitingAtSink = null;
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
        
        if (!blocked) {
            chef.x = next.x;
            chef.y = next.y;
            chef.path.shift();
            
            // Check if reached destination
            if (chef.path.length === 0 && chef.targetStation) {
                interactWithStation(chef, chef.targetStation);
                chef.targetStation = null;
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

    // Update reception stands (customer eating -> dirty dish)
    for (const stand of stations.receptionStands) {
        if (stand.customer) {
            stand.customer.timeLeft -= dt;
            if (stand.customer.timeLeft <= 0) {
                stand.customer = null;
                stand.hasDirtyDish = true;
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
            GameState.score -= 50;
            GameState.streak = 0;
            
            showFloatingText(
                stations.receptionStands.find(s => s.order === expired)?.x || 17,
                stations.receptionStands.find(s => s.order === expired)?.y || 6,
                '⏰ Order expired!', '#f44336'
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
    
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            if (map[y][x] === TILE_TYPES.FLOOR) {
                ctx.fillStyle = floorFillColor(x, y);
                ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            } else {
                drawTile(x, y, map[y][x]);
            }
        }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            ctx.strokeRect(x * CELL_SIZE + 0.5, y * CELL_SIZE + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
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
            color = COLORS.wall;
            break;
        case TILE_TYPES.COUNTER:
            color = COLORS.counter;
            break;
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
        const emoji = INGREDIENT_BIN_EMOJI[bin.ingredient] || '📦';

        ctx.fillStyle = COLORS.ingredientBin;
        ctx.beginPath();
        ctx.roundRect(px + pad, py + pad, CELL_SIZE - pad * 2, CELL_SIZE - pad * 2, 6);
        ctx.fill();

        /* Full inner square (same inset on all sides — was CELL_SIZE-22 height, which left a brown band) */
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

        ctx.font = '22px system-ui, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(emoji, px + CELL_SIZE / 2, py + CELL_SIZE / 2 + 2);
    }

    for (const stove of stations.stoves) {
        const px = stove.x * CELL_SIZE;
        const py = stove.y * CELL_SIZE;

        ctx.fillStyle = stove.cooking ? COLORS.stoveOn : COLORS.stove;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

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

            ctx.fillStyle = COLORS[stove.cooking.ingredient] || '#fff';
            ctx.fillRect(px + 14, py + 14, CELL_SIZE - 28, CELL_SIZE - 28);

            let barColor;
            if (progress >= 1.2) barColor = '#f44336';
            else if (progress >= 0.8) barColor = '#4caf50';
            else barColor = '#ffeb3b';

            const barY = py + CELL_SIZE - 12;
            const barW = CELL_SIZE - 8;
            drawRoundedHBar(px + 4, barY, barW, 8, Math.min(1, progress), barColor, '#333');

            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.font = 'bold 13px system-ui, "Segoe UI", sans-serif';
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

    for (const rack of stations.dishRacks) {
        const px = rack.x * CELL_SIZE;
        const py = rack.y * CELL_SIZE;

        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(px + 4, py + 4, CELL_SIZE - 8, CELL_SIZE - 8);

        for (let s = 0; s < 3; s++) {
            const oy = s * 2.5;
            ctx.fillStyle = '#eceff1';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE / 2 - 4, py + CELL_SIZE / 2 - 2 - oy, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#cfd8dc';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px system-ui, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rack.count), px + CELL_SIZE / 2 + 14, py + CELL_SIZE / 2 - 2);

        const dirty = rack.dirty || 0;
        if (dirty > 0) {
            ctx.fillStyle = 'rgba(62, 39, 35, 0.95)';
            ctx.fillRect(px + 4, py + 4, 22, 16);
            ctx.strokeStyle = '#ffab91';
            ctx.lineWidth = 2;
            ctx.strokeRect(px + 4, py + 4, 22, 16);
            ctx.fillStyle = '#ffccbc';
            ctx.font = 'bold 11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(dirty), px + 15, py + 12);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    for (const board of stations.cuttingBoards) {
        const px = board.x * CELL_SIZE;
        const py = board.y * CELL_SIZE;

        ctx.fillStyle = COLORS.cuttingBoard;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(px + 8, py + 12 + i * 10);
            ctx.lineTo(px + CELL_SIZE - 8, py + 12 + i * 10);
            ctx.stroke();
        }

        if (board.processing) {
            ctx.fillStyle = COLORS[board.processing.ingredient] || '#fff';
            ctx.fillRect(px + 12, py + 12, CELL_SIZE - 24, CELL_SIZE - 24);

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

        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 2;
        ctx.stroke();

        let plateItems = [];
        if (plate.items.length === 1 && plate.items[0].type === 'plate') {
            plateItems = plate.items[0].items;
        } else if (plate.items.length > 0) {
            plateItems = plate.items;
        }

        if (plateItems.length > 0) {
            const angleStep = (Math.PI * 2) / plateItems.length;
            plateItems.forEach((item, i) => {
                const angle = i * angleStep - Math.PI / 2;
                const ix = px + CELL_SIZE / 2 + Math.cos(angle) * 7;
                const iy = py + CELL_SIZE / 2 + Math.sin(angle) * 7;
                ctx.fillStyle = COLORS[item.ingredient] || '#888';
                ctx.beginPath();
                ctx.arc(ix, iy, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            });

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(plateItems.length.toString(), px + CELL_SIZE - 10, py + 14);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    for (const sink of stations.sinks) {
        const px = sink.x * CELL_SIZE;
        const py = sink.y * CELL_SIZE;
        ctx.fillStyle = '#90a4ae';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        ctx.fillStyle = 'rgba(100, 181, 246, 0.35)';
        ctx.beginPath();
        ctx.roundRect(px + 8, py + 8, CELL_SIZE - 16, CELL_SIZE - 16, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(px + 8, py + 8, CELL_SIZE - 16, CELL_SIZE - 16, 8);
        ctx.stroke();
        ctx.font = '22px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('💧', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
    }

    for (const trash of stations.trashCans) {
        const px = trash.x * CELL_SIZE;
        const py = trash.y * CELL_SIZE;
        ctx.fillStyle = '#263238';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        ctx.font = '24px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🗑️', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
    }

    for (let si = 0; si < stations.receptionStands.length; si++) {
        const stand = stations.receptionStands[si];
        const px = stand.x * CELL_SIZE;
        const py = stand.y * CELL_SIZE;
        const standNum = si + 1;

        ctx.fillStyle = COLORS.receptionStand;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(px + 5, py + 5, 16, 13);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px system-ui, sans-serif';
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

            ctx.font = '18px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff';
            ctx.fillText(stand.order.emoji || '🍽️', px + CELL_SIZE / 2, py + CELL_SIZE / 2);

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
            ctx.font = 'bold 22px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#a5d6a7';
            ctx.fillText('✓', px + CELL_SIZE / 2, py + CELL_SIZE / 2);
        } else if (stand.hasDirtyDish) {
            ctx.fillStyle = '#efebe9';
            ctx.beginPath();
            ctx.ellipse(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 14, 10, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#5d4037';
            ctx.beginPath();
            ctx.ellipse(px + CELL_SIZE / 2, py + CELL_SIZE / 2 + 1, 11, 7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#3e2723';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 14, 10, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '20px system-ui, sans-serif';
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

        ctx.fillStyle = COLORS.counter;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, 1);

        if (counter.items && counter.items.length > 0) {
            const top = counter.items[counter.items.length - 1];
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(px + 6, py + 6, CELL_SIZE - 12, CELL_SIZE - 12);

            if (top.type === 'plate') {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 10, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.fillStyle = '#333';
                ctx.font = 'bold 10px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(top.items.length), px + CELL_SIZE / 2, py + CELL_SIZE / 2);
            } else {
                ctx.fillStyle = COLORS[top.ingredient] || '#ccc';
                ctx.beginPath();
                ctx.arc(px + CELL_SIZE / 2, py + CELL_SIZE / 2, 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.01)';
            ctx.fillRect(px + 2, py + CELL_SIZE - 8, CELL_SIZE - 4, 4);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
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
    ctx.font = 'bold 17px system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((chef.id + 1).toString(), cx, cy + 3);

    if (chef.holding) {
        const bx = px + CELL_SIZE - 4;
        const by = py + CELL_SIZE + 2;
        const r = 7;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        if (chef.holding.type === 'plate') {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#263238';
            ctx.font = 'bold 10px system-ui, sans-serif';
            ctx.fillText(String(chef.holding.items.length), bx, by);
        } else {
            ctx.fillStyle = COLORS[chef.holding.ingredient] || '#ccc';
            ctx.beginPath();
            ctx.arc(bx, by, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.font = 'bold 8px system-ui, sans-serif';
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
        ctx.font = '16px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', cx, py + 6);
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
    const bannerH = 22;
    const y0 = h - bannerH;

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, y0, 13 * CELL_SIZE, bannerH);
    ctx.fillRect(14 * CELL_SIZE, y0, 6 * CELL_SIZE, bannerH);

    ctx.fillStyle = 'rgba(200, 210, 220, 0.88)';
    ctx.font = '14px system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('KITCHEN', 6.5 * CELL_SIZE, y0 + bannerH / 2);
    ctx.fillText('SERVICE', 16.5 * CELL_SIZE, y0 + bannerH / 2);
}

// =============================================
// UI UPDATES
// =============================================
let lastDisplayedStreak = 0;

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
        `${GameState.difficulty.toFixed(1)}x · ${phaseLabels[apiPhase]} | ❌ ${GameState.failedOrders}/${GameState.maxFailedOrders}`;

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
                document.getElementById('item-info').textContent = `🍽️ ${items}`;
            } else {
                const stateEmoji = {
                    raw: '🥬',
                    chopped: '🔪',
                    cooked: '🔥',
                    burnt: '💨'
                };
                document.getElementById('item-info').textContent =
                    `${stateEmoji[chef.holding.state]} ${chef.holding.state} ${chef.holding.ingredient}`;
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
        document.getElementById('item-info').textContent = '—';
        document.getElementById('boost-info').textContent = '—';
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
        emojiSpan.textContent = order.emoji || '🍽️';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'order-name';
        nameSpan.textContent = order.dish + (order.vip ? ' ' : '');
        titleWrap.appendChild(emojiSpan);
        titleWrap.appendChild(nameSpan);
        if (order.vip) {
            const vip = document.createElement('span');
            vip.className = 'vip-star';
            vip.textContent = '⭐';
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
            const em = INGREDIENT_BIN_EMOJI[c.ingredient] || '•';
            chip.textContent = `${em} ${c.state}`;
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
    const x = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const y = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    
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
    showFloatingText(chef.x, chef.y, '⚡ Boost!', '#ffd54f');
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
    GameState.running = true;
    GameState.paused = false;
    GameState.gameOver = false;
    GameState.time = 0;
    GameState.score = 0;
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
    
    // Reset stations
    stations.stoves.forEach(s => { s.cooking = null; s.cookTime = 0; s.busy = false; });
    stations.cuttingBoards.forEach(s => { s.processing = null; s.processTime = 0; s.busy = false; });
    stations.platingAreas.forEach(s => { s.items = []; s.busy = false; });
    stations.receptionStands.forEach(s => { s.order = null; s.customer = null; s.hasDirtyDish = false; });
    stations.dishRacks.forEach(r => { r.count = 5; r.dirty = 0; });
    
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
    requestAnimationFrame(gameLoop);
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

    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('pause-btn').disabled = true;
    document.body.classList.remove('game-running');
}

// Button listeners
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('restart-btn').addEventListener('click', startGame);

const shareBtn = document.getElementById('share-btn');
if (shareBtn) {
    shareBtn.addEventListener('click', () => {
        const score = document.getElementById('final-score')?.textContent || '0';
        const grade = document.getElementById('final-grade')?.textContent || '?';
        const streak = document.getElementById('best-streak')?.textContent || '0';
        const text = `I scored ${score} in Kitchen Overflow (Grade: ${grade}, Streak: ${streak}) — Can you beat me? https://example.com/kitchen`;
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
            dirty: !!item.dirty,
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
                } : null,
                hasDirtyDish: r.hasDirtyDish
            })),
            dishRacks: stations.dishRacks.map(r => ({
                id: r.id,
                pos: [r.x, r.y],
                cleanPlates: r.count,
                dirtyPlates: r.dirty || 0,
                maxClean: r.maxCount || 8
            })),
            sinks: stations.sinks.map(s => ({
                id: s.id,
                pos: [s.x, s.y]
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
            sinks: 'sink',
            trashCans: 'trash',
            dishRacks: 'dishRack',
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
            emoji: recipe.emoji,
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

    start: startGame,

    togglePause: togglePause
};

// Initial render
initChefs();
render();

console.log(`
Kitchen Overflow v2.0
================================
API: window.KitchenAPI

Quick start:
  KitchenAPI.start()                    // Start game
  KitchenAPI.getState()                 // Full game state snapshot
  KitchenAPI.command(chefId, stationId) // Send chef to station
  KitchenAPI.boost(chefId)              // Activate speed boost
  KitchenAPI.onTick(fn)                 // Run fn every game frame
  KitchenAPI.getRecipes()               // List all recipes

Station IDs:
  bin_0..5      Ingredient bins (tomato, lettuce, onion, meat, dough, cheese)
  stove_0..2    Stoves
  cutting_0..1  Cutting boards
  plating_0..1  Plating areas
  dishrack_0    Dish rack
  sink_0        Sink
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

Minimal steak agent (single chef — meat on plating_0, then plate, merge, deliver):
  KitchenAPI.onTick(() => {
    const s = KitchenAPI.getState();
    if (!s.running || s.paused) return;
    const c = s.chefs[0];
    if (c.busy || c.hasPath) return;
    const steak = s.orders.find(o => o.dish === 'Steak');
    if (!steak) return;
    const h = c.holding;
    const platItems = s.stations.platingAreas[0].items || [];
    const meatReady = platItems.some(i => i.ingredient === 'meat' && i.state === 'cooked' && i.type !== 'plate');
    if (!h) {
      KitchenAPI.command(0, meatReady ? 'dishrack_0' : 'bin_3');
      return;
    }
    if (h.ingredient === 'meat' && h.state === 'raw') { KitchenAPI.command(0, 'stove_0'); return; }
    if (h.ingredient === 'meat' && h.state === 'cooked') { KitchenAPI.command(0, 'plating_0'); return; }
    if (h.type === 'plate') {
      if (h.items && h.items.some(i => i.ingredient === 'meat' && i.state === 'cooked')) KitchenAPI.command(0, steak.standId);
      else KitchenAPI.command(0, 'plating_0');
    }
  });

Full docs: open docs.html
`);
