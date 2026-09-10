// ============================================================
// SALVO — Battleship over Supabase Realtime
// All game rules (hidden ships, turn order, hit detection, win
// condition) are enforced server-side by the RPC functions in
// schema.sql. This file only renders state and calls those RPCs.
// ============================================================

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const GRID_SIZE = 10;
const FLEET_DEF = [
  { id: "carrier",    name: "Carrier",    size: 5 },
  { id: "battleship", name: "Battleship", size: 4 },
  { id: "cruiser",    name: "Cruiser",    size: 3 },
  { id: "submarine",  name: "Submarine",  size: 3 },
  { id: "destroyer",  name: "Destroyer",  size: 2 },
];

let userId = null;
let game = null;              // current games row
let myFleet = [];             // [{id,name,size,cells:[{x,y}]}]
let placementIndex = 0;       // which ship in FLEET_DEF we're placing
let orientation = "H";        // "H" or "V"
let occupied = new Set();     // "x,y" cells already used while placing
let gameChannel = null;
let shotsChannel = null;
let ownShots = [];            // shots I've fired (vs opponent)
let incomingShots = [];       // shots opponent has fired (vs me)

const $ = (sel) => document.querySelector(sel);
const views = ["lobby", "waiting", "place", "battle", "over"];

function showView(name) {
  for (const v of views) {
    $(`#view-${v}`).classList.toggle("active", v === name);
  }
}

function setConn(state) {
  const dot = $("#connDot");
  const label = $("#connLabel");
  dot.className = "dot " + (state === "live" ? "live" : state === "down" ? "down" : "");
  label.textContent = state === "live" ? "live" : state === "down" ? "disconnected" : "connecting…";
}

// ------------------------------------------------------------
// Boot: anonymous auth
// ------------------------------------------------------------
async function boot() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      userId = session.user.id;
    } else {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      userId = data.user.id;
    }
    setConn("live");
    showView("lobby");
  } catch (err) {
    console.error(err);
    setConn("down");
    $("#lobbyError").textContent =
      "Couldn't connect to Supabase. Check config.js has your project URL/key, " +
      "and that Anonymous sign-ins are enabled (Authentication → Providers).";
  }
}

// ------------------------------------------------------------
// Lobby: create / join
// ------------------------------------------------------------
$("#btnCreate").addEventListener("click", async () => {
  $("#lobbyError").textContent = "";
  $("#btnCreate").disabled = true;
  try {
    const { data, error } = await sb.rpc("create_game");
    if (error) throw error;
    game = data;
    $("#waitingCode").textContent = game.code;
    showView("waiting");
    subscribeToGame(game.id);
  } catch (err) {
    $("#lobbyError").textContent = err.message || "Couldn't create a room.";
  } finally {
    $("#btnCreate").disabled = false;
  }
});

$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#lobbyError").textContent = "";
  const code = $("#joinCode").value.trim().toUpperCase();
  if (code.length !== 4) {
    $("#lobbyError").textContent = "Enter the 4-character room code.";
    return;
  }
  try {
    const { data, error } = await sb.rpc("join_game", { p_code: code });
    if (error) throw error;
    game = data;
    subscribeToGame(game.id);
    enterPlacement();
  } catch (err) {
    $("#lobbyError").textContent = err.message || "Couldn't join that room.";
  }
});

$("#btnCopyCode").addEventListener("click", () => {
  navigator.clipboard?.writeText(game.code);
  $("#btnCopyCode").textContent = "Copied!";
  setTimeout(() => ($("#btnCopyCode").textContent = "Copy code"), 1200);
});

// ------------------------------------------------------------
// Realtime: watch the game row for status/turn changes,
// and the shots log for the live battle.
// ------------------------------------------------------------
function subscribeToGame(gameId) {
  gameChannel?.unsubscribe();
  gameChannel = sb
    .channel(`game-${gameId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
      (payload) => onGameUpdate(payload.new)
    )
    .subscribe();
}

function subscribeToShots(gameId) {
  shotsChannel?.unsubscribe();
  shotsChannel = sb
    .channel(`shots-${gameId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "shots", filter: `game_id=eq.${gameId}` },
      (payload) => onShotInsert(payload.new)
    )
    .subscribe();
}

function onGameUpdate(row) {
  const prevStatus = game?.status;
  game = row;
  if (prevStatus === "waiting" && row.status === "placing") {
    enterPlacement();
  } else if (row.status === "playing" && prevStatus !== "playing") {
    enterBattle();
  } else if (row.status === "playing") {
    renderTurn();
  } else if (row.status === "finished") {
    enterGameOver();
  }
}

function onShotInsert(shot) {
  if (shot.shooter_id === userId) {
    if (!ownShots.find((s) => s.x === shot.x && s.y === shot.y)) ownShots.push(shot);
  } else {
    if (!incomingShots.find((s) => s.x === shot.x && s.y === shot.y)) incomingShots.push(shot);
  }
  renderEnemyGrid();
  renderOwnGrid();
}

// ------------------------------------------------------------
// Ship placement
// ------------------------------------------------------------
function enterPlacement() {
  myFleet = [];
  placementIndex = 0;
  orientation = "H";
  occupied = new Set();
  buildPlaceGrid();
  renderFleetList();
  updatePlaceHint();
  updateOrientationDisplay();
  showView("place");
}

function buildPlaceGrid() {
  const grid = $("#placeGrid");
  grid.innerHTML = "";
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      cell.addEventListener("mouseenter", () => previewShip(x, y));
      cell.addEventListener("mouseleave", clearPreview);
      // Touch devices never fire mouseenter, so without this a player has
      // no way to see the ship's orientation before it's placed.
      cell.addEventListener(
        "touchstart",
        () => previewShip(x, y),
        { passive: true }
      );
      cell.addEventListener("click", () => placeShipAt(x, y));
      grid.appendChild(cell);
    }
  }
}

function shipCellsFor(x, y, size, dir) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const cx = dir === "H" ? x + i : x;
    const cy = dir === "H" ? y : y + i;
    if (cx >= GRID_SIZE || cy >= GRID_SIZE) return null;
    cells.push({ x: cx, y: cy });
  }
  return cells;
}

function canPlace(cells) {
  if (!cells) return false;
  return cells.every((c) => !occupied.has(`${c.x},${c.y}`));
}

function previewShip(x, y) {
  if (placementIndex >= FLEET_DEF.length) return;
  const def = FLEET_DEF[placementIndex];
  const cells = shipCellsFor(x, y, def.size, orientation);
  const ok = canPlace(cells);
  document.querySelectorAll("#placeGrid .cell").forEach((el) => {
    el.classList.remove("preview-ok", "preview-bad");
  });
  (cells || []).forEach((c) => {
    const el = document.querySelector(`#placeGrid .cell[data-x="${c.x}"][data-y="${c.y}"]`);
    if (el) el.classList.add(ok ? "preview-ok" : "preview-bad");
  });
}

function clearPreview() {
  document.querySelectorAll("#placeGrid .cell").forEach((el) => {
    el.classList.remove("preview-ok", "preview-bad");
  });
}

function flashInvalid(x, y) {
  const el = document.querySelector(`#placeGrid .cell[data-x="${x}"][data-y="${y}"]`);
  if (!el) return;
  el.classList.remove("invalid-tap");
  // force reflow so the animation can re-trigger on repeated taps
  void el.offsetWidth;
  el.classList.add("invalid-tap");
}

function placeShipAt(x, y) {
  if (placementIndex >= FLEET_DEF.length) return;
  const def = FLEET_DEF[placementIndex];
  const cells = shipCellsFor(x, y, def.size, orientation);
  if (!canPlace(cells)) {
    flashInvalid(x, y);
    return;
  }

  cells.forEach((c) => {
    occupied.add(`${c.x},${c.y}`);
    const el = document.querySelector(`#placeGrid .cell[data-x="${c.x}"][data-y="${c.y}"]`);
    if (el) el.classList.add("ship");
  });
  myFleet.push({ id: def.id, size: def.size, cells });
  placementIndex++;
  clearPreview();
  renderFleetList();
  updatePlaceHint();

  if (placementIndex >= FLEET_DEF.length) {
    $("#btnReady").disabled = false;
    $("#placeStatus").textContent = "Fleet positioned. Ready when you are.";
  }
}

function updatePlaceHint() {
  const hintBlock = $("#placeHint");
  if (placementIndex >= FLEET_DEF.length) {
    hintBlock.style.display = "none";
    return;
  }
  hintBlock.style.display = "block";
  const def = FLEET_DEF[placementIndex];
  $("#placeShipName").textContent = def.name;
  $("#placeShipSize").textContent = def.size;
}

function renderFleetList() {
  const list = $("#fleetList");
  list.innerHTML = "";
  FLEET_DEF.forEach((def, i) => {
    const li = document.createElement("li");
    li.textContent = `${def.name} · ${def.size}`;
    if (i < placementIndex) li.classList.add("placed");
    else if (i === placementIndex) li.classList.add("active");
    list.appendChild(li);
  });
}

function updateOrientationDisplay() {
  const icon = $("#rotateIcon");
  const label = $("#rotateLabel");
  const isVertical = orientation === "V";
  icon.textContent = "↔";
  icon.classList.toggle("vertical", isVertical);
  label.textContent = isVertical ? "Vertical" : "Horizontal";
}

$("#btnRotate").addEventListener("click", () => {
  orientation = orientation === "H" ? "V" : "H";
  updateOrientationDisplay();
});

$("#btnRandomize").addEventListener("click", () => {
  myFleet = [];
  placementIndex = 0;
  occupied = new Set();
  document.querySelectorAll("#placeGrid .cell").forEach((el) => el.classList.remove("ship"));

  for (const def of FLEET_DEF) {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 400) {
      attempts++;
      const dir = Math.random() < 0.5 ? "H" : "V";
      const x = Math.floor(Math.random() * GRID_SIZE);
      const y = Math.floor(Math.random() * GRID_SIZE);
      const cells = shipCellsFor(x, y, def.size, dir);
      if (canPlace(cells)) {
        cells.forEach((c) => {
          occupied.add(`${c.x},${c.y}`);
          const el = document.querySelector(`#placeGrid .cell[data-x="${c.x}"][data-y="${c.y}"]`);
          if (el) el.classList.add("ship");
        });
        myFleet.push({ id: def.id, size: def.size, cells });
        placed = true;
      }
    }
  }
  placementIndex = FLEET_DEF.length;
  renderFleetList();
  updatePlaceHint();
  $("#btnReady").disabled = false;
  $("#placeStatus").textContent = "Fleet positioned. Ready when you are.";
});

$("#btnReady").addEventListener("click", async () => {
  $("#btnReady").disabled = true;
  const fleet = myFleet.map((s) => ({ id: s.id, size: s.size, cells: s.cells }));
  try {
    const { data, error } = await sb.rpc("submit_ships", {
      p_game_id: game.id,
      p_fleet: fleet,
    });
    if (error) throw error;
    game = data;
    $("#placeStatus").textContent =
      game.status === "playing" ? "Both fleets ready — engaging." : "Waiting on your opponent's fleet…";
    if (game.status === "playing") {
      enterBattle();
    }
  } catch (err) {
    $("#placeStatus").textContent = err.message || "Couldn't lock in your fleet.";
    $("#btnReady").disabled = false;
  }
});

// ------------------------------------------------------------
// Battle
// ------------------------------------------------------------
function enterBattle() {
  ownShots = [];
  incomingShots = [];
  buildBattleGrids();
  subscribeToShots(game.id);
  renderOwnGrid();
  renderTurn();
  showView("battle");
}

function buildBattleGrids() {
  const enemy = $("#enemyGrid");
  enemy.innerHTML = "";
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      cell.addEventListener("click", () => fireAt(x, y));
      enemy.appendChild(cell);
    }
  }

  const own = $("#ownGrid");
  own.innerHTML = "";
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (occupied.has(`${x},${y}`)) cell.classList.add("ship");
      own.appendChild(cell);
    }
  }
}

function renderEnemyGrid() {
  document.querySelectorAll("#enemyGrid .cell").forEach((el) => {
    el.classList.remove("hit", "miss", "sunk");
  });
  ownShots.forEach((s) => {
    const el = document.querySelector(`#enemyGrid .cell[data-x="${s.x}"][data-y="${s.y}"]`);
    if (!el) return;
    el.classList.add(s.sunk ? "sunk" : s.hit ? "hit" : "miss");
  });
}

function renderOwnGrid() {
  incomingShots.forEach((s) => {
    const el = document.querySelector(`#ownGrid .cell[data-x="${s.x}"][data-y="${s.y}"]`);
    if (!el) return;
    el.classList.add(s.sunk ? "sunk" : s.hit ? "hit" : "miss");
  });
}

async function fireAt(x, y) {
  if (game.status !== "playing" || game.turn !== userId) return;
  if (ownShots.find((s) => s.x === x && s.y === y)) return;

  $("#enemyGrid").classList.add("disabled");
  try {
    const { data, error } = await sb.rpc("fire_shot", { p_game_id: game.id, p_x: x, p_y: y });
    if (error) throw error;
    ownShots.push({ x, y, hit: data.hit, sunk: data.sunk });
    renderEnemyGrid();
    if (!data.game_over) {
      const { data: fresh } = await sb.from("games").select("*").eq("id", game.id).single();
      if (fresh) game = fresh;
      renderTurn();
    }
  } catch (err) {
    console.error(err);
  } finally {
    $("#enemyGrid").classList.remove("disabled");
  }
}

function renderTurn() {
  const myTurn = game.turn === userId;
  $("#turnBanner").textContent = myTurn ? "Your move" : "Opponent's move";
  $("#battleSub").textContent = myTurn
    ? "Fire on the enemy grid."
    : "Waiting for your opponent to fire…";
  $("#enemyGrid").classList.toggle("disabled", !myTurn);
}

// ------------------------------------------------------------
// Game over
// ------------------------------------------------------------
function enterGameOver() {
  const won = game.winner === userId;
  $("#overTitle").textContent = won ? "Victory" : "Defeat";
  $("#overSub").textContent = won
    ? "You sank the entire enemy fleet."
    : "Your fleet has been destroyed.";
  showView("over");
}

$("#btnPlayAgain").addEventListener("click", () => {
  gameChannel?.unsubscribe();
  shotsChannel?.unsubscribe();
  game = null;
  $("#joinCode").value = "";
  $("#lobbyError").textContent = "";
  showView("lobby");
});

boot();
