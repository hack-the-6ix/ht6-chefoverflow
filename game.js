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
    }
};

// =============================================
// COLORS
// =============================================
const COLORS = {
    floor: '#2a2a4a',
    floorTile: '#252545',
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
    }
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

function spawnOrder() {
    const availableStands = stations.receptionStands.filter(s => !s.order);
    if (availableStands.length === 0) return;
    
    const stand = availableStands[Math.floor(Math.random() * availableStands.length)];
    
    // Select recipe based on difficulty
    const availableRecipes = Object.entries(RECIPES).filter(
        ([name, recipe]) => recipe.difficulty <= Math.ceil(GameState.difficulty)
    );
    const [dishName, recipe] = availableRecipes[Math.floor(Math.random() * availableRecipes.length)];
    
    const baseTime = 70 - (GameState.difficulty * 5);
    const timeLimit = Math.max(30, baseTime);
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
                    showFloatingText(station.x, station.y, 'No clean plates left!', '#ffb74d');
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

                    const vipTag = station.order.vip ? ' VIP' : '';
                    showFloatingText(station.x, station.y, `+${totalScore}!${vipTag}`, '#4caf50');

                    // Start customer eating lifecycle
                    const deliveredOrder = station.order;
                    station.order = null;
                    const orderIndex = orders.indexOf(deliveredOrder);
                    if (orderIndex > -1) orders.splice(orderIndex, 1);
                    station.customer = { timeLeft: 10 }; // seconds to eat
                    station.hasDirtyDish = false;
                } else {
                    showFloatingText(station.x, station.y, '❌ Wrong dish!', '#f44336');
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

// =============================================
// FLOATING TEXT
// =============================================
const floatingTexts = [];

function showFloatingText(x, y, text, color) {
    floatingTexts.push({
        x: x * CELL_SIZE + CELL_SIZE / 2,
        y: y * CELL_SIZE,
        text: text,
        color: color,
        life: 1.5,
        maxLife: 1.5
    });
}

function updateFloatingTexts(dt) {
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        floatingTexts[i].life -= dt;
        floatingTexts[i].y -= 30 * dt;
        if (floatingTexts[i].life <= 0) {
            floatingTexts.splice(i, 1);
        }
    }
}

function drawFloatingTexts() {
    for (const ft of floatingTexts) {
        const alpha = ft.life / ft.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = ft.color;
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(ft.text, ft.x, ft.y);
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
    
    // Update difficulty
    GameState.difficulty = 1 + GameState.time / 90; // Slower difficulty ramp

    // Update rush hour
    if (GameState.rush.active) {
        GameState.rush.timeLeft -= dt;
        if (GameState.rush.timeLeft <= 0) {
            GameState.rush.active = false;
            GameState.rush.cooldown = 30 + Math.random() * 25;
        }
    } else {
        GameState.rush.cooldown -= dt;
        if (GameState.rush.cooldown <= 0) {
            GameState.rush.active = true;
            GameState.rush.timeLeft = 10 + Math.random() * 6;
            showFloatingText(12, 2, 'RUSH HOUR!', '#ffd54f');
        }
    }
    
    // Spawn orders
    const baseInterval = GameState.rush.active ? 10 : 20;
    const orderInterval = Math.max(6, baseInterval - GameState.difficulty * 2);
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
            GameState.failedOrders++;
            GameState.score -= 50;
            GameState.streak = 0;
            
            showFloatingText(
                stations.receptionStands.find(s => s.order === orders[i])?.x || 17,
                stations.receptionStands.find(s => s.order === orders[i])?.y || 6,
                '⏰ Order expired!', '#f44336'
            );
            
            // Clear from stand
            const stand = stations.receptionStands.find(s => s.order === orders[i]);
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
    
    // Draw checkered floor
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            const isLight = (x + y) % 2 === 0;
            if (map[y][x] === TILE_TYPES.FLOOR) {
                ctx.fillStyle = isLight ? COLORS.floor : COLORS.floorTile;
                ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            } else {
                drawTile(x, y, map[y][x]);
            }
        }
    }
    
    // Draw stations with details
    drawStations();
    
    // Draw chefs
    for (const chef of chefs) {
        drawChef(chef);
    }

    // Draw counters on top so items sit visibly on the surface
    drawCounters();
    
    // Draw path preview for selected chef
    if (GameState.selectedChef !== null) {
        const chef = chefs[GameState.selectedChef];
        if (chef.path.length > 0) {
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(chef.x * CELL_SIZE + CELL_SIZE/2, chef.y * CELL_SIZE + CELL_SIZE/2);
            for (const p of chef.path) {
                ctx.lineTo(p.x * CELL_SIZE + CELL_SIZE/2, p.y * CELL_SIZE + CELL_SIZE/2);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    
    // Draw floating texts
    drawFloatingTexts();
    
    // Draw labels
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
    // Draw ingredient bins
    for (const bin of stations.ingredientBins) {
        const px = bin.x * CELL_SIZE;
        const py = bin.y * CELL_SIZE;
        
        // Bin background
        ctx.fillStyle = COLORS.ingredientBin;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        // Draw ingredient color
        ctx.fillStyle = COLORS[bin.ingredient] || '#fff';
        ctx.fillRect(px + 8, py + 8, CELL_SIZE - 16, CELL_SIZE - 16);
        
        // Border
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        // Label
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(bin.ingredient.substring(0, 3).toUpperCase(), px + CELL_SIZE/2, py + CELL_SIZE - 8);
    }
    
    // Draw stoves with cooking indicators
    for (const stove of stations.stoves) {
        const px = stove.x * CELL_SIZE;
        const py = stove.y * CELL_SIZE;
        
        // Stove base
        ctx.fillStyle = stove.cooking ? COLORS.stoveOn : COLORS.stove;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        // Burner rings
        ctx.strokeStyle = stove.cooking ? '#ffeb3b' : '#666';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 12, 0, Math.PI * 2);
        ctx.stroke();
        
        if (stove.cooking) {
            // Flame animation
            const flicker = Math.sin(Date.now() / 100) * 2;
            ctx.fillStyle = '#ff9800';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2 + flicker, 8, 0, Math.PI * 2);
            ctx.fill();
            
            // Cooking item
            ctx.fillStyle = COLORS[stove.cooking.ingredient] || '#fff';
            ctx.fillRect(px + 14, py + 14, CELL_SIZE - 28, CELL_SIZE - 28);
            
            // Progress bar
            const progress = Math.min(1.5, stove.cookTime / stove.maxCookTime);
            let barColor;
            if (progress >= 1.2) barColor = '#f44336'; // Burning!
            else if (progress >= 0.8) barColor = '#4caf50'; // Ready!
            else barColor = '#ffeb3b'; // Cooking
            
            ctx.fillStyle = '#333';
            ctx.fillRect(px + 4, py + CELL_SIZE - 10, CELL_SIZE - 8, 6);
            ctx.fillStyle = barColor;
            ctx.fillRect(px + 4, py + CELL_SIZE - 10, (CELL_SIZE - 8) * Math.min(1, progress), 6);
            
            // Status text
            if (progress >= 1.2) {
                ctx.fillStyle = '#f44336';
                ctx.font = 'bold 10px Arial';
                ctx.fillText('BURNING!', px + CELL_SIZE/2, py - 5);
            } else if (progress >= 0.8) {
                ctx.fillStyle = '#4caf50';
                ctx.font = 'bold 10px Arial';
                ctx.fillText('READY!', px + CELL_SIZE/2, py - 5);
            }
        }
        
        // Border
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }

    // Draw dish racks (stack of clean plates)
    for (const rack of stations.dishRacks) {
        const px = rack.x * CELL_SIZE;
        const py = rack.y * CELL_SIZE;

        // Rack base
        ctx.fillStyle = '#8d6e63';
        ctx.fillRect(px + 4, py + 4, CELL_SIZE - 8, CELL_SIZE - 8);

        // Plate icon and counts
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2 - 4, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#333';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(String(rack.count), px + CELL_SIZE/2, py + CELL_SIZE/2 + 14);

        // Dirty pile indicator
        const dirty = rack.dirty || 0;
        if (dirty > 0) {
            ctx.fillStyle = '#ff7043';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE - 10, py + 10, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = '10px Arial';
            ctx.fillText(String(dirty), px + CELL_SIZE - 10, py + 14);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }
    
    // counters are rendered on top (see drawCounters)
    
    // Draw cutting boards
    for (const board of stations.cuttingBoards) {
        const px = board.x * CELL_SIZE;
        const py = board.y * CELL_SIZE;
        
        // Board
        ctx.fillStyle = COLORS.cuttingBoard;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        // Wood grain lines
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
            
            // Chopping progress
            const progress = board.processTime / board.maxProcessTime;
            ctx.fillStyle = '#333';
            ctx.fillRect(px + 4, py + CELL_SIZE - 10, CELL_SIZE - 8, 6);
            ctx.fillStyle = '#4caf50';
            ctx.fillRect(px + 4, py + CELL_SIZE - 10, (CELL_SIZE - 8) * progress, 6);
            
            // Knife animation
            const knifeX = px + 10 + (CELL_SIZE - 20) * progress;
            ctx.fillStyle = '#bdbdbd';
            ctx.fillRect(knifeX, py + 8, 4, 16);
        }
        
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }
    
    // Draw plating areas
    for (const plate of stations.platingAreas) {
        const px = plate.x * CELL_SIZE;
        const py = plate.y * CELL_SIZE;
        
        // Counter
        ctx.fillStyle = COLORS.platingArea;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        // Plate circle
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ddd';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Determine items to render: plating area may hold ingredients or a plate item
        let plateItems = [];
        if (plate.items.length === 1 && plate.items[0].type === 'plate') {
            plateItems = plate.items[0].items;
        } else if (plate.items.length > 0) {
            plateItems = plate.items;
        }

        // Items on plate (or on plating area that will become a plate)
        if (plateItems.length > 0) {
            const angleStep = (Math.PI * 2) / plateItems.length;
            plateItems.forEach((item, i) => {
                const angle = i * angleStep - Math.PI/2;
                const ix = px + CELL_SIZE/2 + Math.cos(angle) * 6;
                const iy = py + CELL_SIZE/2 + Math.sin(angle) * 6;
                ctx.fillStyle = COLORS[item.ingredient] || '#888';
                ctx.beginPath();
                ctx.arc(ix, iy, 5, 0, Math.PI * 2);
                ctx.fill();
            });

            // Item count
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(plateItems.length.toString(), px + CELL_SIZE - 10, py + 14);
        }
        
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }
    
    // Draw reception stands
    for (const stand of stations.receptionStands) {
        const px = stand.x * CELL_SIZE;
        const py = stand.y * CELL_SIZE;
        
        // Stand
        ctx.fillStyle = COLORS.receptionStand;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        
        if (stand.order) {
            const urgency = stand.order.timeLeft / stand.order.maxTime;
            
            // Order indicator with urgency color
            ctx.fillStyle = urgency < 0.25 ? '#f44336' : (urgency < 0.5 ? '#ff9800' : '#4caf50');
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 14, 0, Math.PI * 2);
            ctx.fill();
            
            // Dish emoji
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(stand.order.emoji || '🍽️', px + CELL_SIZE/2, py + CELL_SIZE/2);
            
            // Timer arc
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 18, -Math.PI/2, -Math.PI/2 + (Math.PI * 2 * urgency));
            ctx.stroke();
            
            // Pulsing for urgent
            if (urgency < 0.25) {
                ctx.strokeStyle = `rgba(244, 67, 54, ${0.5 + Math.sin(Date.now() / 100) * 0.5})`;
                ctx.lineWidth = 4;
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
            }
        } else if (stand.hasDirtyDish) {
            // Dirty dish indicator
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#6d4c41';
            ctx.beginPath();
            ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 8, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Empty stand indicator
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = '20px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', px + CELL_SIZE/2, py + CELL_SIZE/2);
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

        // Counter surface
        ctx.fillStyle = COLORS.counter;
        ctx.fillRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);

        // If an item is present, draw it clearly on top
        if (counter.items && counter.items.length > 0) {
            const top = counter.items[counter.items.length - 1];
            // small highlight behind item
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            ctx.fillRect(px + 6, py + 6, CELL_SIZE - 12, CELL_SIZE - 12);

            if (top.type === 'plate') {
                ctx.fillStyle = '#fff';
                ctx.beginPath();
                ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 10, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#333';
                ctx.font = 'bold 10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(String(top.items.length), px + CELL_SIZE - 12, py + 14);
            } else {
                ctx.fillStyle = COLORS[top.ingredient] || '#ccc';
                ctx.beginPath();
                ctx.arc(px + CELL_SIZE/2, py + CELL_SIZE/2, 8, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            // subtle empty counter highlight
            ctx.fillStyle = 'rgba(255,255,255,0.01)';
            ctx.fillRect(px + 2, py + CELL_SIZE - 8, CELL_SIZE - 4, 4);
        }

        // Full indicator if occupied
        if (counter.items && counter.items.length >= 1) {
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(px + CELL_SIZE - 28, py + 4, 24, 14);
            ctx.fillStyle = '#ffb74d';
            ctx.font = '10px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('FULL', px + CELL_SIZE - 16, py + 14);
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
    }
}

function drawChef(chef) {
    const px = chef.x * CELL_SIZE;
    const py = chef.y * CELL_SIZE;
    
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(px + CELL_SIZE/2, py + CELL_SIZE - 6, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Chef body
    ctx.fillStyle = COLORS.chef[chef.id];
    ctx.beginPath();
    ctx.roundRect(px + 6, py + 8, CELL_SIZE - 12, CELL_SIZE - 14, 6);
    ctx.fill();
    
    // Chef hat
    ctx.fillStyle = '#fff';
    ctx.fillRect(px + 12, py + 2, CELL_SIZE - 24, 10);
    ctx.fillRect(px + 10, py + 8, CELL_SIZE - 20, 4);
    
    // Selection indicator
    if (GameState.selectedChef === chef.id) {
        ctx.strokeStyle = COLORS.chefSelected;
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        ctx.setLineDash([]);
        
        // Selection glow
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 10;
        ctx.strokeRect(px + 2, py + 2, CELL_SIZE - 4, CELL_SIZE - 4);
        ctx.shadowBlur = 0;
    }
    
    // Chef number
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((chef.id + 1).toString(), px + CELL_SIZE/2, py + CELL_SIZE/2 + 4);
    
    // Held item indicator
    if (chef.holding) {
        const itemX = px + CELL_SIZE - 8;
        const itemY = py + 4;
        
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(itemX, itemY + 6, 10, 0, Math.PI * 2);
        ctx.fill();
        
        if (chef.holding.type === 'plate') {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(itemX, itemY + 6, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#4caf50';
            ctx.font = '10px Arial';
            ctx.fillText(chef.holding.items.length.toString(), itemX, itemY + 9);
        } else {
            ctx.fillStyle = COLORS[chef.holding.ingredient];
            ctx.beginPath();
            ctx.arc(itemX, itemY + 6, 6, 0, Math.PI * 2);
            ctx.fill();
            
            // State indicator
            if (chef.holding.state === INGREDIENT_STATES.CHOPPED) {
                ctx.strokeStyle = '#4caf50';
                ctx.lineWidth = 2;
                ctx.stroke();
            } else if (chef.holding.state === INGREDIENT_STATES.COOKED) {
                ctx.strokeStyle = '#ff9800';
                ctx.lineWidth = 2;
                ctx.stroke();
            } else if (chef.holding.state === INGREDIENT_STATES.BURNT) {
                ctx.strokeStyle = '#f44336';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }
    
    // Busy indicator (working animation)
    if (chef.busy) {
        ctx.fillStyle = '#ffeb3b';
        const bounce = Math.sin(Date.now() / 150) * 3;
        ctx.font = '14px Arial';
        ctx.fillText('⚡', px + 8, py + bounce);
    }
}

function drawLabels() {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    
    // Kitchen label
    ctx.fillText('🍳 KITCHEN', 6 * CELL_SIZE, MAP_HEIGHT * CELL_SIZE - 8);
    
    // Service label
    ctx.fillText('🧑‍🍳 SERVICE', 16 * CELL_SIZE, MAP_HEIGHT * CELL_SIZE - 8);
}

// =============================================
// UI UPDATES
// =============================================
function updateUI() {
    document.getElementById('score').textContent = Math.floor(GameState.score);
    document.getElementById('time').textContent = formatTime(GameState.time);
    document.getElementById('difficulty').textContent = GameState.difficulty.toFixed(1) + 'x';
    document.getElementById('streak').textContent = `${GameState.streak} (x${(1 + Math.min(1.0, GameState.streak * 0.05)).toFixed(2)})`;
    const rushDisplay = document.getElementById('rush');
    const rushPill = document.getElementById('rush-display');
    rushDisplay.textContent = GameState.rush.active ? `LIVE ${Math.ceil(GameState.rush.timeLeft)}s` : `Idle ${Math.ceil(GameState.rush.cooldown)}s`;
    if (GameState.rush.active) {
        rushPill.classList.add('hot');
    } else {
        rushPill.classList.remove('hot');
    }
    
    // Update selected chef info
    if (GameState.selectedChef !== null) {
        const chef = chefs[GameState.selectedChef];
        document.getElementById('chef-info').textContent = `Chef ${chef.id + 1} (${chef.name})`;
        
        if (chef.holding) {
            if (chef.holding.type === 'plate') {
                const items = chef.holding.items.map(i => i.ingredient).join(', ');
                document.getElementById('item-info').textContent = `🍽️ Plate: ${items}`;
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
            document.getElementById('boost-info').textContent = `Cooldown ${Math.ceil(chef.boostCooldown)}s`;
        } else {
            document.getElementById('boost-info').textContent = 'Ready';
        }
    } else {
        document.getElementById('chef-info').textContent = 'Click a chef to select';
        document.getElementById('item-info').textContent = '-';
        document.getElementById('boost-info').textContent = '-';
    }
    
    // Update orders panel
    const ordersList = document.getElementById('orders-list');
    ordersList.innerHTML = '';
    
    if (orders.length === 0) {
        ordersList.innerHTML = '<div style="color: #888; text-align: center; padding: 20px;">No orders yet...</div>';
    }
    
    for (const order of orders) {
        const card = document.createElement('div');
        const urgencyClass = order.timeLeft < order.maxTime * 0.25 ? ' urgent' : '';
        const vipClass = order.vip ? ' vip' : '';
        card.className = 'order-card' + urgencyClass + vipClass;
        
        const urgency = order.timeLeft / order.maxTime;
        const components = order.recipe.components.map(c => 
            `${c.state} ${c.ingredient}`
        ).join(', ');
        
        card.innerHTML = `
            <div class="order-dish">${order.emoji} ${order.dish}${order.vip ? ' ⭐ VIP' : ''}</div>
            <div class="order-components">${components}</div>
            <div class="order-time">${Math.ceil(order.timeLeft)}s remaining</div>
            <div class="order-timer">
                <div class="order-timer-fill ${urgency < 0.25 ? 'urgent' : ''}" 
                     style="width: ${urgency * 100}%"></div>
            </div>
        `;
        
        ordersList.appendChild(card);
    }
    
    // Update failed orders (augment difficulty line)
    document.getElementById('difficulty').textContent = 
        `${GameState.difficulty.toFixed(1)}x | ❌ ${GameState.failedOrders}/${GameState.maxFailedOrders}`;
}

// =============================================
// RULES / RESTRICTIONS UI
// =============================================
const RESTRICTIONS_UI = [
    'No slicing bread — don\'t chop Dough (🍞).',
    'No serving raw meat — cook meat before plating (🥩).',
    'Be nice to stoves — no surfing on burners (😅).'
];

function initRulesUI() {
    const list = document.getElementById('rules-list');
    if (!list) return; // graceful if DOM not present

    list.innerHTML = '';
    RESTRICTIONS_UI.forEach(r => {
        const li = document.createElement('li');
        li.textContent = r;
        list.appendChild(li);
    });

    const toggle = document.getElementById('rules-toggle');
    const panel = document.getElementById('rules-panel');
    if (toggle && panel) {
        toggle.addEventListener('click', () => {
            const hidden = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');
            toggle.textContent = hidden ? 'Hide Rules' : 'Show Rules';
        });
    }
}

// Initialize rules UI right away (script is loaded at end of body)
try { initRulesUI(); } catch (e) { /* ignore in test env */ }

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
            // Find walkable tile adjacent to station
            const adjacent = findAdjacentWalkable(x, y);
            if (adjacent) {
                const path = findPath(chef.x, chef.y, adjacent.x, adjacent.y);
                if (path.length > 0 || (chef.x === adjacent.x && chef.y === adjacent.y)) {
                    chef.path = path;
                    chef.targetStation = stationInfo;
                } else if (chef.x === adjacent.x && chef.y === adjacent.y) {
                    // Already adjacent, interact immediately
                    interactWithStation(chef, stationInfo);
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

function activateBoost() {
    if (GameState.selectedChef === null) return;
    const chef = chefs[GameState.selectedChef];
    if (!chef || chef.boostActive || chef.boostCooldown > 0) return;

    chef.boostActive = true;
    chef.boostTime = 3.5;
    chef.boostCooldown = 12;
    showFloatingText(chef.x, chef.y, '⚡ Boost!', '#ffd54f');
}

// =============================================
// GAME CONTROL
// =============================================
function startGame() {
    GameState.running = true;
    GameState.paused = false;
    GameState.time = 0;
    GameState.score = 0;
    GameState.difficulty = 1.0;
    GameState.streak = 0;
    GameState.bestStreak = 0;
    GameState.failedOrders = 0;
    GameState.selectedChef = null;
    GameState.moveTimer = 0;
    GameState.rush.active = false;
    GameState.rush.timeLeft = 0;
    GameState.rush.cooldown = 20;
    
    // Reset stations
    stations.stoves.forEach(s => { s.cooking = null; s.cookTime = 0; s.busy = false; });
    stations.cuttingBoards.forEach(s => { s.processing = null; s.processTime = 0; s.busy = false; });
    stations.platingAreas.forEach(s => { s.items = []; s.busy = false; });
    stations.receptionStands.forEach(s => { s.order = null; s.customer = null; s.hasDirtyDish = false; });
    stations.dishRacks.forEach(r => { r.count = r.maxCount || 8; r.dirty = 0; });
    
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
    
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);
}

function togglePause() {
    GameState.paused = !GameState.paused;
    document.getElementById('pause-btn').textContent = GameState.paused ? 'Resume' : 'Pause';
}

function endGame() {
    GameState.running = false;
    document.getElementById('final-score').textContent = Math.floor(GameState.score);
    document.getElementById('best-streak').textContent = GameState.bestStreak;
    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('pause-btn').disabled = true;
}

// Button listeners
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('restart-btn').addEventListener('click', startGame);

// =============================================
// AGENT API (for programmatic control)
// =============================================
window.KitchenAPI = {
    // Get full game state
    getState: () => ({
        time: GameState.time,
        score: GameState.score,
        difficulty: GameState.difficulty,
        streak: GameState.streak,
        bestStreak: GameState.bestStreak,
        rush: { ...GameState.rush },
        failedOrders: GameState.failedOrders,
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
    
    // Send command to chef
    command: (chefId, targetId) => {
        if (!GameState.running || GameState.paused) return { success: false, error: 'Game not running' };
        
        const chef = chefs.find(c => c.id === chefId);
        if (!chef) return { success: false, error: 'Invalid chef_id' };
        if (chef.busy) return { success: false, error: 'Chef is busy' };
        
        // Find target station
        let stationInfo = null;
        let targetX, targetY;
        
        const stationTypes = {
            ingredientBins: 'ingredientBin',
            stoves: 'stove', 
            cuttingBoards: 'cuttingBoard',
            platingAreas: 'platingArea',
            receptionStands: 'receptionStand'
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
        
        const path = findPath(chef.x, chef.y, adjacent.x, adjacent.y);
        if (path.length === 0 && !(chef.x === adjacent.x && chef.y === adjacent.y)) {
            return { success: false, error: 'No path found' };
        }
        
        chef.path = path;
        chef.targetStation = stationInfo;
        
        return { success: true };
    },
    
    // Select chef (for visualization)
    selectChef: (chefId) => {
        GameState.selectedChef = chefId;
    },
    
    // Start game
    start: startGame,
    
    // Pause/resume
    togglePause: togglePause
};

// Initial render
initChefs();
render();

console.log('🍳 Autonomous Kitchen Arena loaded!');
console.log('Use window.KitchenAPI for programmatic control:');
console.log('  KitchenAPI.getState() - Get full game state');
console.log('  KitchenAPI.command(chefId, targetId) - Send chef to station');
console.log('  KitchenAPI.start() - Start game');
